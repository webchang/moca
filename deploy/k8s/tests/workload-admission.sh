#!/usr/bin/env bash
# The workload-sandboxes admission policy (base/workload-sandboxes/admission-policy.yaml), evaluated
# by a real API server: every case is a `kubectl create --dry-run=server` as moca-provisioner's
# ServiceAccount, so RBAC and the ValidatingAdmissionPolicy both run and nothing is persisted.
# Well-formed objects -- the StatefulSet built from the cluster's own PodTemplate the way
# packages/provisioner/src/provisioner.ts builds it -- must be admitted; each unsafe one refused by
# the policy (not by RBAC). Then RBAC alone (kubectl auth can-i): the lists the orphan sweep makes are
# granted, and Secrets stay unreadable.
#
#   deploy/k8s/tests/workload-admission.sh [--context CTX]
#
# Needs a cluster with the component applied (SH_WORKLOAD_SANDBOXES=1 deploy/k8s/setup.sh ...) and
# a caller allowed to impersonate. k8s-e2e.yml runs it after the live smoke. Default context:
# kind-moca.
set -euo pipefail

CTX=kind-moca
[[ "${1-}" != --context ]] || CTX="${2:?--context needs a value}"
AS=system:serviceaccount:moca:moca-provisioner
NS=moca-sandbox
WL="w-$(printf '0123456789abcdef%.0s' 1 2)"
FAILED=0

kc() { kubectl --context "$CTX" "$@"; }

# try WANT NAME JSON: WANT is allow or deny.
try() {
  local want="$1" name="$2" obj="$3" out
  if out="$(kc create --dry-run=server --as="$AS" -n "$NS" -f - <<<"$obj" 2>&1)"; then
    if [[ "$want" == allow ]]; then echo "ok - admitted: $name"; return; fi
    echo "FAIL - admitted, expected a refusal: $name"
  else
    if [[ "$want" == deny ]] && grep -q 'ValidatingAdmissionPolicy' <<<"$out"; then
      echo "ok - refused: $name"
      return
    fi
    echo "FAIL - $( [[ "$want" == deny ]] && echo 'refused, but not by the policy' || echo 'refused, expected admission'): $name"
    sed 's/^/  | /' <<<"$out"
  fi
  FAILED=1
}

# The binding provisioner.ts adds to the operator's PodTemplate: labels, env, the attach token.
template="$(kc get podtemplate moca-workload-sandbox -n "$NS" -o json)"
sts="$(jq -c --arg wl "$WL" '
  { apiVersion: "apps/v1", kind: "StatefulSet",
    metadata: { name: $wl, labels: { app: "moca-workload-sandbox", "moca.dev/workload": $wl } },
    spec: {
      serviceName: $wl, replicas: 1, podManagementPolicy: "Parallel",
      selector: { matchLabels: { app: "moca-workload-sandbox", "moca.dev/workload": $wl } },
      template: {
        metadata: { labels: { app: "moca-workload-sandbox", "moca.dev/workload": $wl } },
        spec: (.template.spec
          | .automountServiceAccountToken = false
          | .containers[0].env += [{ name: "SANDBOX_TOKEN_FILE", value: "/run/moca-attach/token" }]
          | .containers[0].volumeMounts = ((.containers[0].volumeMounts // []) +
              [{ name: "attach-token", mountPath: "/run/moca-attach", readOnly: true }])
          | .volumes = ((.volumes // []) +
              [{ name: "attach-token", secret: { secretName: "\($wl)-attach", defaultMode: 288 } }]))
      } } }' <<<"$template")"
# sts_with JQ: the good StatefulSet with one change.
sts_with() { jq -c "$1" <<<"$sts"; }
vol() { sts_with ".spec.template.spec.volumes += [$1]"; }

svc="$(jq -nc --arg wl "$WL" '
  { apiVersion: "v1", kind: "Service", metadata: { name: $wl },
    spec: { clusterIP: "None", selector: { app: "moca-workload-sandbox", "moca.dev/workload": $wl } } }')"
svc_with() { jq -c "$1" <<<"$svc"; }
# A mounted workload's own PVC (spec §5.1), as provisioner.ts's claim() writes it. No class: the
# API server fills in the cluster's default, which setup.sh allowlists when
# SH_WORKLOAD_STORAGE_CLASSES is unset.
pvc="$(jq -nc --arg wl "$WL" '
  { apiVersion: "v1", kind: "PersistentVolumeClaim",
    metadata: { name: $wl, labels: { app: "moca-workload-sandbox", "moca.dev/workload": $wl } },
    spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } } }')"
pvc_with() { jq -c "$1" <<<"$pvc"; }
# The StatefulSet of a mounted workload: its own claim, as one volume.
own_claim='{name: "context", persistentVolumeClaim: {claimName: "'"$WL"'"}}'
secret="$(jq -nc --arg wl "$WL" '
  { apiVersion: "v1", kind: "Secret", type: "Opaque", metadata: { name: "\($wl)-attach" },
    data: { token: "eA==" } }')"

echo "== admitted: what the provisioner writes"
try allow 'StatefulSet from the PodTemplate, with its binding' "$sts"
try allow 'StatefulSet with emptyDir, configMap and downwardAPI volumes' "$(vol '{name: "e", emptyDir: {}}, {name: "c", configMap: {name: "x"}}, {name: "d", downwardAPI: {items: []}}')"
try allow 'headless Service selecting its own pods' "$svc"
try allow 'Opaque <name>-attach Secret' "$secret"
try allow 'StatefulSet mounting its own <name> PVC' "$(vol "$own_claim")"
try allow 'a ReadWriteOnce <name> PVC in the default (allowlisted) class' "$pvc"

echo "== refused: StatefulSets"
try deny 'a hostPath volume' "$(vol '{name: "h", hostPath: {path: "/"}}')"
try deny 'another Secret as a volume' "$(vol '{name: "s", secret: {secretName: "moca-relay-attach"}}')"
try deny 'a PVC volume' "$(vol '{name: "p", persistentVolumeClaim: {claimName: "anything"}}')"
try deny "another workload's PVC" "$(vol '{name: "p", persistentVolumeClaim: {claimName: "w-ffffffffffffffffffffffffffffffff"}}')"
try deny "Redis's PVC" "$(vol '{name: "p", persistentVolumeClaim: {claimName: "data-redis-0"}}')"
try deny 'its own PVC through two volumes' "$(vol "$own_claim, {name: \"again\", persistentVolumeClaim: {claimName: \"$WL\"}}")"
try deny 'an ephemeral volume' "$(vol '{name: "v", ephemeral: {volumeClaimTemplate: {spec: {accessModes: ["ReadWriteOnce"], resources: {requests: {storage: "1Gi"}}}}}}')"
try deny 'a projected service-account token' "$(vol '{name: "t", projected: {sources: [{serviceAccountToken: {path: "t"}}]}}')"
try deny 'an inline csi volume' "$(vol '{name: "c", csi: {driver: "x"}}')"
try deny 'another ServiceAccount' "$(sts_with '.spec.template.spec.serviceAccountName = "default"')"
try deny 'a mounted service-account token' "$(sts_with '.spec.template.spec.automountServiceAccountToken = true')"
try deny 'a privileged container' "$(sts_with '.spec.template.spec.containers[0].securityContext.privileged = true | .spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation = true')"
try deny 'an added capability' "$(sts_with '.spec.template.spec.containers[0].securityContext.capabilities.add = ["NET_ADMIN"]')"
try deny 'the host network' "$(sts_with '.spec.template.spec.hostNetwork = true')"
try deny "another Secret in env" "$(sts_with '.spec.template.spec.containers[0].env += [{name: "X", valueFrom: {secretKeyRef: {name: "moca-relay-attach", key: "SH_RELAY_TOKEN"}}}]')"
try deny 'a raw device (volumeDevices) on a container' "$(vol "$own_claim" | jq -c '.spec.template.spec.containers[0].volumeDevices = [{name: "context", devicePath: "/dev/xvda"}]')"
try deny 'a raw device (volumeDevices) on an init container' "$(vol "$own_claim" | jq -c '.spec.template.spec.initContainers = [{name: "i", image: .spec.template.spec.containers[0].image, volumeDevices: [{name: "context", devicePath: "/dev/xvda"}]}]')"
try deny 'a volumeClaimTemplate' "$(sts_with '.spec.volumeClaimTemplates = [{metadata: {name: "v"}, spec: {accessModes: ["ReadWriteOnce"], resources: {requests: {storage: "1Gi"}}}}]')"
try deny 'a serviceName of another Service' "$(sts_with '.spec.serviceName = "sandbox-relay"')"
try deny 'a name that is not a workload key (the shared pool)' "$(sts_with '.metadata.name = "moca-sandbox"')"
try deny 'pods not labelled app=moca-workload-sandbox' "$(sts_with '.spec.template.metadata.labels.app = "moca-sandbox" | .spec.selector.matchLabels.app = "moca-sandbox"')"

echo "== refused: Services"
try deny 'externalIPs' "$(svc_with '.spec.clusterIP = "" | del(.spec.clusterIP) | .spec.externalIPs = ["203.0.113.1"] | .spec.ports = [{port: 80}]')"
try deny 'type NodePort' "$(svc_with 'del(.spec.clusterIP) | .spec.type = "NodePort" | .spec.ports = [{port: 80}]')"
try deny 'type LoadBalancer' "$(svc_with 'del(.spec.clusterIP) | .spec.type = "LoadBalancer" | .spec.ports = [{port: 80}]')"
try deny 'a ClusterIP with an address' "$(svc_with 'del(.spec.clusterIP) | .spec.ports = [{port: 80}]')"
try deny 'ports on the headless Service' "$(svc_with '.spec.ports = [{port: 80}]')"
try deny "a selector on the shared pool" "$(svc_with '.spec.selector = {app: "moca-sandbox"}')"
try deny "another workload's pods" "$(svc_with '.spec.selector["moca.dev/workload"] = "w-ffffffffffffffffffffffffffffffff"')"
try deny 'a selector wider than its own pods' "$(svc_with '.spec.selector = {app: "moca-workload-sandbox"}')"
try deny 'type ExternalName' "$(svc_with 'del(.spec.clusterIP) | del(.spec.selector) | .spec.type = "ExternalName" | .spec.externalName = "example.com"')"

echo "== refused: PVCs"
try deny 'a PVC not named w-<32 hex>' "$(pvc_with '.metadata.name = "data-redis-0"')"
try deny 'a PVC in a class outside the allowlist' "$(pvc_with '.spec.storageClassName = "moca-not-allowlisted"')"
try deny 'ReadWriteMany on a class not allowlisted as rwx' "$(pvc_with '.spec.accessModes = ["ReadWriteMany"]')"
try deny "a clone of another workload's PVC (dataSource)" "$(pvc_with '.spec.dataSource = {kind: "PersistentVolumeClaim", name: "w-ffffffffffffffffffffffffffffffff"}')"
try deny "a clone of another workload's PVC (dataSourceRef)" "$(pvc_with '.spec.dataSourceRef = {kind: "PersistentVolumeClaim", name: "w-ffffffffffffffffffffffffffffffff"}')"
try deny 'a pre-provisioned PV by volumeName' "$(pvc_with '.spec.volumeName = "pv-someone-else"')"
try deny 'a pre-provisioned PV by selector' "$(pvc_with '.spec.selector = {matchLabels: {owner: "someone-else"}}')"
try deny 'a Block volumeMode' "$(pvc_with '.spec.volumeMode = "Block"')"

echo "== refused: Secrets"
try deny 'a Secret not named <name>-attach' "$(jq -c '.metadata.name = "moca-relay-attach"' <<<"$secret")"
try deny 'a Secret that is not Opaque' "$(jq -c '.type = "moca.dev/other"' <<<"$secret")"

# can VERB RESOURCE WANT: RBAC alone, as the provisioner's ServiceAccount (yes or no).
can() {
  local got
  got="$(kc auth can-i "$1" "$2" --as="$AS" -n "$NS" 2>/dev/null || true)"
  if [[ "$got" == "$3" ]]; then echo "ok - can-i $1 $2: $3"; return; fi
  echo "FAIL - can-i $1 $2: $got, expected $3"
  FAILED=1
}

echo "== RBAC: what the orphan sweep lists (spec §6.2), and still no read on Secrets"
can list statefulsets yes
can list services yes
can list persistentvolumeclaims yes
can list secrets no
can get secrets no
can create pods no

if [[ "$FAILED" != 0 ]]; then
  echo "workload-admission.sh: FAILED" >&2
  exit 1
fi
echo "workload-admission.sh: all passed"
