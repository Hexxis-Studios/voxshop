# Optional hosted preview adapter

Sites is a temporary preview adapter, not the engine's required home. The Windows editor, local browser authoring, stdio MCP and exported games work without a Sites account.

The optional adapter lives under `hosting/sites/`. Local account/project bindings are private files under `.openai/`; do not commit, archive or distribute them. Hosted deployments need their own account's configured project and tool discovery. Do not assume a project ID from another account is accessible.

The local adapter provides live connected-editor viewport observations. The hosted Sites adapter exposes static previews and playtests but no live editor viewport observations; connect through the local adapter for camera and Play output.

Public releases use GitHub and itch.io. Deploying a hosted preview is a separate action and is not part of the normal desktop build.
