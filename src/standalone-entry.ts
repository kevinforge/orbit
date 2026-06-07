/**
 * Standalone entry point for Orbit.
 *
 * This file is used when building a standalone executable with Bun compile.
 * It imports the main server which starts automatically on import.
 *
 * Usage:
 *   bun build ./src/standalone-entry.ts --compile --bytecode --minify --sourcemap=none --outfile=orbit.exe
 *
 * When running the standalone binary:
 *   - Set ORBIT_UI_DIR=/path/to/ui/assets to specify UI asset location
 *   - Or place UI assets in ./dist/ui/ relative to the binary
 */

// Import the main server - it starts automatically
import "./server/index.ts";
