#!/usr/bin/env node
import { ObsidianServer } from "./server";
import { createCreateNoteTool } from "./tools/create-note";
import { createEditNoteTool } from "./tools/edit-note";
import { createSearchVaultTool } from "./tools/search-vault";
import { createMoveNoteTool } from "./tools/move-note";
import { createCreateDirectoryTool } from "./tools/create-directory";
import { createDeleteNoteTool } from "./tools/delete-note";
import { createAddTagsTool } from "./tools/add-tags";
import { createRemoveTagsTool } from "./tools/remove-tags";
import { createRenameTagTool } from "./tools/rename-tag";
import { createReadNoteTool } from "./tools/read-note";

interface VaultConfig {
  name: string;
  path: string;
}

async function main() {
  const vaultArgs = process.argv.slice(2);
  if (vaultArgs.length === 0) {
    console.error("Please provide paths to your Obsidian vaults");
    console.error("Usage: obsidian-mcp <vault1_path> [vault2_path ...]");
    process.exit(1);
  }

  // Create vault configurations
  const vaults: VaultConfig[] = vaultArgs.map((path, index) => ({
    name: `vault${index + 1}`,
    path
  }));

  try {
    const server = new ObsidianServer(vaults);

    // Create vaults Map
    const vaultsMap = new Map(vaults.map(v => [v.name, v.path]));

    // Register tools
    server.registerTool(createCreateNoteTool(vaultsMap));
    server.registerTool(createEditNoteTool(vaultsMap));
    server.registerTool(createSearchVaultTool(vaultsMap));
    server.registerTool(createMoveNoteTool(vaultsMap));
    server.registerTool(createCreateDirectoryTool(vaultsMap));
    server.registerTool(createDeleteNoteTool(vaultsMap));
    server.registerTool(createAddTagsTool(vaultsMap));
    server.registerTool(createRemoveTagsTool(vaultsMap));
    server.registerTool(createRenameTagTool(vaultsMap));
    server.registerTool(createReadNoteTool(vaultsMap));

    await server.start();
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
