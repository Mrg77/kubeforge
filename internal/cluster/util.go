package cluster

import (
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
)

// age renders a duration since t the way kubectl does: the largest sensible
// unit ("3d", "5h", "12m", "8s"), so the UI reads like the tool people know.
func age(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return strconv.Itoa(int(d.Seconds())) + "s"
	case d < time.Hour:
		return strconv.Itoa(int(d.Minutes())) + "m"
	case d < 24*time.Hour:
		return strconv.Itoa(int(d.Hours())) + "h"
	default:
		return strconv.Itoa(int(d.Hours()/24)) + "d"
	}
}

func itoa(n int) string { return strconv.Itoa(n) }

// nodeRoles extracts the node roles from the standard role labels
// (node-role.kubernetes.io/<role>), joined, or "<none>".
func nodeRoles(n *corev1.Node) string {
	var roles []string
	const prefix = "node-role.kubernetes.io/"
	for k := range n.Labels {
		if strings.HasPrefix(k, prefix) {
			if r := strings.TrimPrefix(k, prefix); r != "" {
				roles = append(roles, r)
			}
		}
	}
	if len(roles) == 0 {
		return "<none>"
	}
	return strings.Join(roles, ",")
}
