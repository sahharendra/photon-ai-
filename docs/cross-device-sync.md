# Cross-device workspace storage

The authenticated workspace is stored by the backend and synchronized with clients using authenticated API requests. Conversations and projects are merged by stable IDs; attachment contents are stored on the backend, and clients poll for remote changes every 15 seconds. Artifact edits require the current artifact version.

The current backend store is `photon-profile-data.json`, not a relational database. For persistent Render storage, attach a persistent disk to the web service and let Render set `RENDER_DISK_PATH` to its mount path. Run one server instance when using this file store; it is not a multi-instance database.

For local deployments, set `PHOTON_DATA_DIR` to a persistent directory, or set `PHOTON_DATA_FILE` to an explicit file path. To copy an existing store into a new location, set `PHOTON_MIGRATE_FROM` to the existing file path for the first startup. The copy only occurs if the destination does not exist; keep a separate backup before migrating.

If Render has no persistent disk configured, the server logs a warning because local files may be lost on restart or redeploy. Cross-device behavior can work while that server process is running, but durable production storage is not guaranteed until a persistent disk is mounted.
