package storage

import (
	"strconv"
	"time"

	"k8s.io/apimachinery/pkg/api/resource"
)

func gib(q *resource.Quantity) float64 {
	if q == nil {
		return 0
	}
	return float64(q.Value()) / (1024 * 1024 * 1024)
}

func round(f float64) float64 { return float64(int(f*100+0.5)) / 100 }

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
