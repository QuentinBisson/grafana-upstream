import { countBy, isEqual } from 'lodash';
import { useMemo, useRef } from 'react';

import {
  AlertGroupTotals,
  AlertInstanceTotalState,
  AlertInstanceTotals,
  AlertingRule,
  CombinedRule,
  CombinedRuleGroup,
  CombinedRuleNamespace,
  Rule,
  RuleGroup,
  RuleNamespace,
  RulesSource,
} from 'app/types/unified-alerting';
import {
  PromAlertingRuleState,
  RulerRuleDTO,
  RulerRuleGroupDTO,
  RulerRulesConfigDTO,
} from 'app/types/unified-alerting-dto';

import { alertRuleApi } from '../api/alertRuleApi';
import { GRAFANA_RULER_CONFIG } from '../api/featureDiscoveryApi';
import { RULE_LIST_POLL_INTERVAL_MS } from '../utils/constants';
import {
  GRAFANA_RULES_SOURCE_NAME,
  getAllRulesSources,
  getRulesSourceByName,
  isCloudRulesSource,
  isGrafanaRulesSource,
} from '../utils/datasource';
import { hashQuery } from '../utils/rule-id';
import { getAnnotations, isPausedRule, prometheusRuleType, rulerRuleType } from '../utils/rules';

import { useUnifiedAlertingSelector } from './useUnifiedAlertingSelector';

export interface CacheValue {
  promRules?: RuleNamespace[];
  rulerRules?: RulerRulesConfigDTO | null;
  result: CombinedRuleNamespace[];
}

// this little monster combines prometheus rules and ruler rules to produce a unified data structure
// can limit to a single rules source
export function useCombinedRuleNamespaces(
  rulesSourceName?: string,
  grafanaPromRuleNamespaces?: RuleNamespace[]
): CombinedRuleNamespace[] {
  const promRulesResponses = useUnifiedAlertingSelector((state) => state.promRules);
  const rulerRulesResponses = useUnifiedAlertingSelector((state) => state.rulerRules);

  // cache results per rules source, so we only recalculate those for which results have actually changed
  const cache = useRef<Record<string, CacheValue>>({});

  const rulesSources = useMemo((): RulesSource[] => {
    if (rulesSourceName) {
      const rulesSource = getRulesSourceByName(rulesSourceName);
      if (!rulesSource) {
        throw new Error(`Unknown rules source: ${rulesSourceName}`);
      }
      return [rulesSource];
    }
    return getAllRulesSources();
  }, [rulesSourceName]);

  return useMemo(() => {
    return rulesSources
      .map((rulesSource): CombinedRuleNamespace[] => {
        const rulesSourceName = isCloudRulesSource(rulesSource) ? rulesSource.name : rulesSource;
        const rulerRules = rulerRulesResponses[rulesSourceName]?.result;

        let promRules = promRulesResponses[rulesSourceName]?.result;
        if (rulesSourceName === GRAFANA_RULES_SOURCE_NAME && grafanaPromRuleNamespaces) {
          promRules = grafanaPromRuleNamespaces;
        }

        const cached = cache.current[rulesSourceName];
        if (cached && cached.promRules === promRules && cached.rulerRules === rulerRules) {
          return cached.result;
        }
        const namespaces: Record<string, CombinedRuleNamespace> = {};

        // first get all the ruler rules from the data source
        Object.entries(rulerRules || {}).forEach(([namespaceName, groups]) => {
          const namespace: CombinedRuleNamespace = {
            rulesSource,
            name: namespaceName,
            groups: [],
          };

          // We need to set the namespace_uid for grafana rules as it's required to obtain the rule's groups
          // All rules from all groups have the same namespace_uid so we're taking the first one.
          if (rulerRuleType.grafana.rule(groups[0].rules[0])) {
            namespace.uid = groups[0].rules[0].grafana_alert.namespace_uid;
          }

          namespaces[namespaceName] = namespace;
          addRulerGroupsToCombinedNamespace(namespace, groups);
        });

        // then correlate with prometheus rules
        promRules?.forEach(({ name: namespaceName, groups }) => {
          const ns = (namespaces[namespaceName] = namespaces[namespaceName] || {
            rulesSource,
            name: namespaceName,
            groups: [],
          });

          addPromGroupsToCombinedNamespace(ns, groups);
        });

        const result = Object.values(namespaces);

        cache.current[rulesSourceName] = { promRules, rulerRules, result };
        return result;
      })
      .flat();
  }, [promRulesResponses, rulerRulesResponses, rulesSources, grafanaPromRuleNamespaces]);
}

export function combineRulesNamespace(
  rulesSource: RulesSource,
  promNamespaces: RuleNamespace[],
  rulerRules?: RulerRulesConfigDTO
): CombinedRuleNamespace[] {
  const namespaces: Record<string, CombinedRuleNamespace> = {};

  // first get all the ruler rules from the data source
  Object.entries(rulerRules || {}).forEach(([namespaceName, groups]) => {
    const namespace: CombinedRuleNamespace = {
      rulesSource,
      name: namespaceName,
      groups: [],
    };
    namespaces[namespaceName] = namespace;
    addRulerGroupsToCombinedNamespace(namespace, groups);
  });

  // then correlate with prometheus rules
  promNamespaces?.forEach(({ name: namespaceName, groups }) => {
    const ns = (namespaces[namespaceName] = namespaces[namespaceName] || {
      rulesSource,
      name: namespaceName,
      groups: [],
    });

    addPromGroupsToCombinedNamespace(ns, groups);
  });

  return Object.values(namespaces);
}

export function attachRulerRulesToCombinedRules(
  rulesSource: RulesSource,
  promNamespace: RuleNamespace,
  rulerGroups: RulerRuleGroupDTO[]
): CombinedRuleNamespace {
  const ns: CombinedRuleNamespace = {
    rulesSource: rulesSource,
    name: promNamespace.name,
    groups: [],
  };

  // The order is important. Adding Ruler rules overrides Prometheus rules.
  addRulerGroupsToCombinedNamespace(ns, rulerGroups);
  addPromGroupsToCombinedNamespace(ns, promNamespace.groups);

  // Remove ruler rules which does not have Prom rule counterpart
  // This function should only attach Ruler rules to existing Prom rules
  ns.groups.forEach((group) => {
    group.rules = group.rules.filter((rule) => rule.promRule);
  });

  return ns;
}

export function attachRulerRuleToCombinedRule(rule: CombinedRule, rulerGroup: RulerRuleGroupDTO): void {
  if (!rule.promRule) {
    return;
  }

  const combinedRulesFromRuler = rulerGroup.rules.map((rulerRule) =>
    rulerRuleToCombinedRule(rulerRule, rule.namespace, rule.group)
  );
  const existingRulerRulesByUidOrName = combinedRulesFromRuler.reduce((acc, rule) => {
    const sameNameOrUidRules = acc.get(getIdToCompare(rule));
    if (sameNameOrUidRules) {
      sameNameOrUidRules.push(rule);
    } else {
      acc.set(getIdToCompare(rule), [rule]);
    }
    return acc;
  }, new Map<string, CombinedRule[]>());

  const matchingRulerRule = getExistingRuleInGroup(
    rule.promRule,
    existingRulerRulesByUidOrName,
    rule.namespace.rulesSource
  );
  if (matchingRulerRule) {
    rule.rulerRule = matchingRulerRule.rulerRule;
    rule.query = matchingRulerRule.query;
    rule.labels = matchingRulerRule.labels;
    rule.annotations = matchingRulerRule.annotations;
  }
}

export function addCombinedPromAndRulerGroups(
  ns: CombinedRuleNamespace,
  promGroups: RuleGroup[],
  rulerGroups: RulerRuleGroupDTO[]
): CombinedRuleNamespace {
  addRulerGroupsToCombinedNamespace(ns, rulerGroups);
  addPromGroupsToCombinedNamespace(ns, promGroups);
  return ns;
}

// merge all groups in case of grafana managed, essentially treating namespaces (folders) as groups
export function flattenGrafanaManagedRules(namespaces: CombinedRuleNamespace[]) {
  return namespaces.map((namespace) => {
    const newNamespace: CombinedRuleNamespace = {
      ...namespace,
      groups: [],
    };

    // add default group with ungrouped rules
    newNamespace.groups.push({
      name: 'default',
      rules: sortRulesByName(namespace.groups.flatMap((group) => group.rules)),
      totals: calculateAllGroupsTotals(namespace.groups),
    });

    return newNamespace;
  });
}

export function sortRulesByName(rules: CombinedRule[]) {
  return rules.sort((a, b) => a.name.localeCompare(b.name));
}

export function addRulerGroupsToCombinedNamespace(
  namespace: CombinedRuleNamespace,
  groups: RulerRuleGroupDTO[] = []
): void {
  namespace.groups = groups.map((group) => {
    const numRecordingRules = group.rules.filter((rule) => rulerRuleType.any.recordingRule(rule)).length;
    const numPaused = group.rules.filter((rule) => {
      return rulerRuleType.grafana.alertingRule(rule) && isPausedRule(rule);
    }).length;

    const combinedGroup: CombinedRuleGroup = {
      name: group.name,
      interval: group.interval,
      source_tenants: group.source_tenants,
      rules: [],
      totals: {
        paused: numPaused,
        recording: numRecordingRules,
      },
    };
    combinedGroup.rules = group.rules.map((rule) => rulerRuleToCombinedRule(rule, namespace, combinedGroup));
    return combinedGroup;
  });
}

export function addPromGroupsToCombinedNamespace(namespace: CombinedRuleNamespace, groups: RuleGroup[]): void {
  const existingGroupsByName = new Map<string, CombinedRuleGroup>();
  namespace.groups.forEach((group) => existingGroupsByName.set(group.name, group));

  groups.forEach((group) => {
    let combinedGroup = existingGroupsByName.get(group.name);
    if (!combinedGroup) {
      combinedGroup = {
        name: group.name,
        rules: [],
        totals: calculateGroupTotals(group),
      };
      namespace.groups.push(combinedGroup);
      existingGroupsByName.set(group.name, combinedGroup);
    }

    // combine totals from ruler with totals from prometheus state API
    combinedGroup.totals = {
      ...combinedGroup.totals,
      ...calculateGroupTotals(group),
    };

    const combinedRulesByUidOrName = new Map<string, CombinedRule[]>();
    combinedGroup!.rules.forEach((r) => {
      // Prometheus rules do not have to be unique by name
      const existingRule = combinedRulesByUidOrName.get(getIdToCompare(r));
      existingRule ? existingRule.push(r) : combinedRulesByUidOrName.set(getIdToCompare(r), [r]);
    });

    (group.rules ?? []).forEach((rule) => {
      const existingRule = getExistingRuleInGroup(rule, combinedRulesByUidOrName, namespace.rulesSource);
      if (existingRule) {
        existingRule.promRule = rule;
        existingRule.instanceTotals = prometheusRuleType.alertingRule(rule) ? calculateRuleTotals(rule) : {};
        existingRule.filteredInstanceTotals = prometheusRuleType.alertingRule(rule)
          ? calculateRuleFilteredTotals(rule)
          : {};
      } else {
        combinedGroup!.rules.push(promRuleToCombinedRule(rule, namespace, combinedGroup!));
      }
    });
  });
}

export function calculateRuleTotals(rule: Pick<AlertingRule, 'alerts' | 'totals'>): AlertInstanceTotals {
  const result = countBy(rule.alerts, 'state');

  if (rule.totals) {
    const { normal, ...totals } = rule.totals;
    return { ...totals, inactive: normal };
  }

  return {
    alerting: result[AlertInstanceTotalState.Alerting] || result.firing,
    pending: result[AlertInstanceTotalState.Pending],
    recovering: result[AlertInstanceTotalState.Recovering],
    inactive: result[AlertInstanceTotalState.Normal],
    nodata: result[AlertInstanceTotalState.NoData],
    error: result[AlertInstanceTotalState.Error] || result.err || undefined, // Prometheus uses "err" instead of "error"
  };
}

export function calculateRuleFilteredTotals(
  rule: Pick<AlertingRule, 'alerts' | 'totalsFiltered'>
): AlertInstanceTotals {
  if (rule.totalsFiltered) {
    const { normal, ...totals } = rule.totalsFiltered;
    return { ...totals, inactive: normal };
  }
  return {};
}

export function calculateGroupTotals(group: Pick<RuleGroup, 'rules' | 'totals'>): AlertGroupTotals {
  if (group.totals) {
    const { firing, ...totals } = group.totals;

    return {
      ...totals,
      alerting: firing,
    };
  }

  const countsByState = countBy(group.rules, (rule) => prometheusRuleType.alertingRule(rule) && rule.state);
  const countsByHealth = countBy(group.rules, (rule) => rule.health);
  const recordingCount = group.rules.filter((rule) => prometheusRuleType.recordingRule(rule)).length;

  return {
    alerting: countsByState[PromAlertingRuleState.Firing],
    error: countsByHealth.error,
    nodata: countsByHealth.nodata,
    inactive: countsByState[PromAlertingRuleState.Inactive],
    pending: countsByState[PromAlertingRuleState.Pending],
    recovering: countsByState[PromAlertingRuleState.Recovering],
    recording: recordingCount,
  };
}

function calculateAllGroupsTotals(groups: CombinedRuleGroup[]): AlertGroupTotals {
  const totals: Record<string, number> = {};

  groups.forEach((group) => {
    const groupTotals = group.totals;
    Object.entries(groupTotals).forEach(([key, value]) => {
      if (!totals[key]) {
        totals[key] = 0;
      }

      if (value !== undefined && value !== null) {
        totals[key] += value;
      }
    });
  });

  return totals;
}

function promRuleToCombinedRule(rule: Rule, namespace: CombinedRuleNamespace, group: CombinedRuleGroup): CombinedRule {
  return {
    name: rule.name,
    query: rule.query,
    labels: rule.labels || {},
    annotations: prometheusRuleType.alertingRule(rule) ? getAnnotations(rule) : {},
    promRule: rule,
    namespace: namespace,
    group,
    instanceTotals: prometheusRuleType.alertingRule(rule) ? calculateRuleTotals(rule) : {},
    filteredInstanceTotals: prometheusRuleType.alertingRule(rule) ? calculateRuleFilteredTotals(rule) : {},
  };
}

function rulerRuleToCombinedRule(
  rule: RulerRuleDTO,
  namespace: CombinedRuleNamespace,
  group: CombinedRuleGroup
): CombinedRule {
  const commonProps = {
    labels: rule.labels || {},
    rulerRule: rule,
    namespace,
    group,
    instanceTotals: {},
    filteredInstanceTotals: {},
    uid: rulerRuleType.grafana.rule(rule) ? rule.grafana_alert.uid : undefined,
  };

  if (rulerRuleType.dataSource.alertingRule(rule)) {
    return {
      ...commonProps,
      name: rule.alert,
      query: rule.expr,
      annotations: rule.annotations || {},
    };
  }
  if (rulerRuleType.dataSource.recordingRule(rule)) {
    return {
      ...commonProps,
      name: rule.record,
      query: rule.expr,
      annotations: {},
    };
  }
  return {
    ...commonProps,
    name: rule.grafana_alert.title,
    query: '',
    annotations: rule.annotations || {},
  };
}

// find existing rule in group that matches the given prom rule
function getExistingRuleInGroup(
  rule: Rule,
  existingCombinedRulesMap: Map<string, CombinedRule[]>, // map by uid
  rulesSource: RulesSource
): CombinedRule | undefined {
  // Using Map of name-based rules is important performance optimization for the code below
  // Otherwise we would perform find method multiple times on (possibly) thousands of rules

  const fieldToSearch = getIdToCompare(rule);
  const uidOrNameMatchingRules = existingCombinedRulesMap.get(fieldToSearch);
  if (!uidOrNameMatchingRules) {
    return undefined;
  }

  if (isGrafanaRulesSource(rulesSource)) {
    return uidOrNameMatchingRules[0];
  }

  // try finding a rule that matches name, labels, annotations and query
  const strictlyMatchingRule = uidOrNameMatchingRules.find(
    (combinedRule) => !combinedRule.promRule && isCombinedRuleEqualToPromRule(combinedRule, rule, true)
  );
  if (strictlyMatchingRule) {
    return strictlyMatchingRule;
  }

  // if that fails, try finding a rule that only matches name, labels and annotations.
  // loki & prom can sometimes modify the query so it doesnt match, eg `2 > 1` becomes `1`
  const looselyMatchingRule = uidOrNameMatchingRules.find(
    (combinedRule) => !combinedRule.promRule && isCombinedRuleEqualToPromRule(combinedRule, rule, false)
  );
  if (looselyMatchingRule) {
    return looselyMatchingRule;
  }

  return undefined;
}

function isCombinedRuleEqualToPromRule(combinedRule: CombinedRule, rule: Rule, checkQuery = true): boolean {
  const promRuleAnnotations = prometheusRuleType.alertingRule(rule) ? getAnnotations(rule) : {};
  const promRuleLabels = rule.labels ?? {};
  const promQuery = checkQuery ? hashQuery(rule.query) : '';

  const combinedRuleAnnotations = combinedRule.annotations;
  const combinedRuleLabels = combinedRule.labels;
  const combinedRuleQuery = checkQuery ? hashQuery(combinedRule.query) : '';

  if (combinedRule.name === rule.name) {
    return isEqual(
      [combinedRuleQuery, combinedRuleLabels, combinedRuleAnnotations],
      [promQuery, promRuleLabels, promRuleAnnotations]
    );
  }
  return false;
}

/*
  This hook returns combined Grafana rules. Optionally, it can filter rules by dashboard UID and panel ID.
*/
export function useCombinedRules(
  dashboardUID?: string | null,
  panelId?: number,
  poll?: boolean
): {
  loading: boolean;
  result?: CombinedRuleNamespace[];
  error?: unknown;
} {
  const isNewDashboard = !Boolean(dashboardUID);

  const {
    currentData: promRuleNs,
    isLoading: isLoadingPromRules,
    error: promRuleNsError,
  } = alertRuleApi.endpoints.prometheusRuleNamespaces.useQuery(
    {
      ruleSourceName: GRAFANA_RULES_SOURCE_NAME,
      dashboardUid: dashboardUID ?? undefined,
      panelId,
    },
    {
      skip: isNewDashboard,
      pollingInterval: poll ? RULE_LIST_POLL_INTERVAL_MS : undefined,
    }
  );

  const {
    currentData: rulerRules,
    isLoading: isLoadingRulerRules,
    error: rulerRulesError,
  } = alertRuleApi.endpoints.rulerRules.useQuery(
    {
      rulerConfig: GRAFANA_RULER_CONFIG,
      filter: { dashboardUID: dashboardUID ?? undefined, panelId },
    },
    {
      pollingInterval: poll ? RULE_LIST_POLL_INTERVAL_MS : undefined,
      skip: isNewDashboard,
    }
  );

  //---------
  // cache results per rules source, so we only recalculate those for which results have actually changed
  const cache = useRef<Record<string, CacheValue>>({});

  const rulesSource = getRulesSourceByName(GRAFANA_RULES_SOURCE_NAME);

  const rules = useMemo(() => {
    if (!rulesSource) {
      return [];
    }

    const cached = cache.current[GRAFANA_RULES_SOURCE_NAME];
    if (cached && cached.promRules === promRuleNs && cached.rulerRules === rulerRules) {
      return cached.result;
    }
    const namespaces: Record<string, CombinedRuleNamespace> = {};

    // first get all the ruler rules from the data source
    Object.entries(rulerRules || {}).forEach(([namespaceName, groups]) => {
      const namespace: CombinedRuleNamespace = {
        rulesSource,
        name: namespaceName,
        groups: [],
      };

      // We need to set the namespace_uid for grafana rules as it's required to obtain the rule's groups
      // All rules from all groups have the same namespace_uid so we're taking the first one.
      if (rulerRuleType.grafana.rule(groups[0].rules[0])) {
        namespace.uid = groups[0].rules[0].grafana_alert.namespace_uid;
      }

      namespaces[namespaceName] = namespace;
      addRulerGroupsToCombinedNamespace(namespace, groups);
    });

    // then correlate with prometheus rules
    promRuleNs?.forEach(({ name: namespaceName, groups }) => {
      const ns = (namespaces[namespaceName] = namespaces[namespaceName] || {
        rulesSource,
        name: namespaceName,
        groups: [],
      });

      addPromGroupsToCombinedNamespace(ns, groups);
    });

    const result = Object.values(namespaces);

    cache.current[GRAFANA_RULES_SOURCE_NAME] = { promRules: promRuleNs, rulerRules, result };
    return result;
  }, [promRuleNs, rulerRules, rulesSource]);

  return {
    loading: isLoadingPromRules || isLoadingRulerRules,
    error: promRuleNsError ?? rulerRulesError,
    result: rules,
  };
}
/**
 * Returns the ID of the rule to compare.
 * If the rule has a UID, it will be used, otherwise the rule name will be used.
 * cloud rules don't have a UID, so the name will be used.
 */
function getIdToCompare(rule: CombinedRule | Rule): string {
  if (Boolean(rule.uid)) {
    return rule.uid ?? '';
  }
  return rule.name;
}
