/**
 * Installed lifecycle regression (release host-trust closure §1 regression):
 *
 * Runs the installed lifecycle in regression mode where a required semantic is deliberately
 * omitted, causing a gate failure. The script MUST exit non-zero.
 */
process.env.MESH2THREEJS_LIFECYCLE_REGRESSION = "1";
await import("./installed-lifecycle.js");