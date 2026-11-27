# Activation marker

`workspaceContains:.specify/` is one of the extension's two activation events, so
this directory is what makes the host launch activate the extension the way a real
planning workspace does — rather than because a test reached in and called
`activate()`.

The body exists only because git does not track an empty directory. Nothing reads
it.
