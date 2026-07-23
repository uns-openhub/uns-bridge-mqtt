# Security policy

Report vulnerabilities through GitHub private vulnerability reporting, not a
public issue.

Never commit controller credentials, MQTT credentials, TLS private keys,
private broker mappings, generated live metadata, or runtime state. The
management API requires controller JWKS authentication.
