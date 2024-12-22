#!/usr/bin/env node
import { ObsidianServer } from "./server.js";
import { NoteTools } from "./tools/note-tools.js";
import { SearchTools } from "./tools/search-tools.js";

async function main() {
  const vaultPath = process.argv[2];
  if (!vaultPath) {
    console.error("Please provide the path to your Obsidian vault");
    process.exit(1);
  }

  try {
    const server = new ObsidianServer(vaultPath);
    
    // Register tool providers
    server.registerToolProvider(new NoteTools(vaultPath));
    server.registerToolProvider(new SearchTools(vaultPath));

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
