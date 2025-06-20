package helpers

import (
	"html/template"
)

func TruncateString(length int, s string) string {
	if len(s) <= length {
		return s
	}
	return s[:length]
}

var funcMap = template.FuncMap{
	"truncate": TruncateString,
}

func GetFuncMap() *template.FuncMap {
	return &funcMap
}
