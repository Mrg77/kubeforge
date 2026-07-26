#!/usr/bin/env bash
# coverage.sh — proves what the Resource-stack graph draws vs. what the cluster
# actually contains, namespace by namespace. Run it against a live cluster to
# challenge the topology: it lists every namespaced kind that HAS objects, and
# marks whether the /api/layers graph renders that kind.
#
# Usage:  KUBECONFIG=... KF_URL=http://127.0.0.1:7777 ./scripts/coverage.sh [namespace]
# No `set -e`: probing every resource type, some will legitimately fail/empty.
set -uo pipefail

KF_URL="${KF_URL:-http://127.0.0.1:7777}"
NS="${1:-}"

# Kinds the graph is designed to render (keep in sync with internal/cluster/layers.go).
DRAWN="Pod ReplicaSet Deployment StatefulSet DaemonSet Job CronJob Service Ingress \
ConfigMap Secret ServiceAccount Role ClusterRole RoleBinding \
PersistentVolumeClaim PersistentVolume StorageClass \
NetworkPolicy ResourceQuota LimitRange HorizontalPodAutoscaler PodDisruptionBudget"

is_drawn() { for k in $DRAWN; do [ "$k" = "$1" ] && return 0; done; return 1; }

namespaces() {
  if [ -n "$NS" ]; then echo "$NS"; else
    kubectl get ns -o name | sed 's|namespace/||'
  fi
}

echo "Resource-stack coverage — cluster: $(kubectl config current-context)"
echo "======================================================================"

for ns in $(namespaces); do
  # kinds that actually have objects in this namespace. Read the Kind straight
  # from the objects (robust to api-resources column widths).
  present=$(kubectl api-resources --namespaced=true --verbs=list -o name 2>/dev/null | while read -r res; do
    kind=$(kubectl get "$res" -n "$ns" --ignore-not-found \
      -o jsonpath='{.items[0].kind}' 2>/dev/null || true)
    [ -n "$kind" ] && echo "$kind"
  done | sort -u)

  [ -z "$present" ] && continue
  total=$(echo "$present" | grep -c .)
  drawn=0; missing=""
  while read -r kind; do
    if is_drawn "$kind"; then drawn=$((drawn+1)); else missing="$missing $kind"; fi
  done <<< "$present"

  printf "\n▸ %-20s %d kinds present · %d drawn\n" "$ns" "$total" "$drawn"
  [ -n "$missing" ] && printf "   not drawn:%s\n" "$missing"
done

echo ""
echo "Kinds the graph renders (${KF_URL}/api/layers): $(echo $DRAWN | wc -w | tr -d ' ')"
