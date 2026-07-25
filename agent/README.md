# Agent Assets For datadog-mcp

This folder contains implementation assets used to adapt and extend this Datadog MCP server while preserving required guarantees:
- Secrets persist in Vault
- Configuration persists in Postgres
- User scoping is mandatory
- Datadog API coverage remains complete through catalog regeneration

Primary references:
- Playbook: `agent/playbooks/service-onboarding.md`
- Specification template: `agent/templates/service-spec.md`
