# Optional hosted preview adapter

Sites is a temporary preview adapter, not the engine's required home. The Windows editor, local browser authoring, stdio MCP and exported games work without a Sites account.

The optional adapter lives under `hosting/sites/`. Local account/project bindings are private files under `.openai/`; do not commit, archive or distribute them. Hosted deployments need their own account's configured project and tool discovery. Do not assume a project ID from another account is accessible.

The local adapter provides connected-editor PNG walkthrough tools. Hosted adapters expose their own discovered schemas and may provide only static previews; do not claim equivalent live viewport verification without checking their actual tools.

Public releases use GitHub and itch.io. Deploying a hosted preview is a separate action and is not part of the normal desktop build.
