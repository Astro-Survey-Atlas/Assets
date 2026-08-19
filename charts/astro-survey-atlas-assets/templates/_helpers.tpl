{{- define "astro-survey-atlas-assets.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "astro-survey-atlas-assets.fullname" -}}
{{- if .Values.fullnameOverride }}{{ .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}{{- else }}{{ include "astro-survey-atlas-assets.name" . }}{{- end }}
{{- end }}

{{- define "astro-survey-atlas-assets.labels" -}}
app.kubernetes.io/name: {{ include "astro-survey-atlas-assets.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end }}

