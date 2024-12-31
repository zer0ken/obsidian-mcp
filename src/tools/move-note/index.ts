import { z } from "zod";
import { Tool } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { fileExists, ensureDirectory } from "../../utils/files.js";
import { updateVaultLinks } from "../../utils/links.js";
import { createNoteExistsError, createNoteNotFoundError, handleFsError } from "../../utils/errors.js";
import { createSchemaHandler } from "../../utils/schema.js";

// Input validation schema with descriptions
const schema = z.object({
  vault: z.string()
    .min(1, "Vault name cannot be empty")
    .describe("Name of the vault containing the note"),
  source: z.string()
    .min(1, "Source path cannot be empty")
    .refine(name => !path.isAbsolute(name), 
      "Source must be a relative path within the vault")
    .describe("Source path of the note relative to vault root (e.g., 'folder/note.md')"),
  destination: z.string()
    .min(1, "Destination path cannot be empty")
    .refine(name => !path.isAbsolute(name), 
      "Destination must be a relative path within the vault")
    .describe("Destination path relative to vault root (e.g., 'new-folder/new-name.md')")
}).strict();

// Create schema handler that provides both Zod validation and JSON Schema
const schemaHandler = createSchemaHandler(schema);

async function moveNote(
  vaultPath: string,
  sourcePath: string,
  destinationPath: string
): Promise<string> {
  // Ensure paths are relative to vault
  const fullSourcePath = path.join(vaultPath, sourcePath);
  const fullDestPath = path.join(vaultPath, destinationPath);

  // Validate paths are within vault
  validateVaultPath(vaultPath, fullSourcePath);
  validateVaultPath(vaultPath, fullDestPath);

  try {
    // Check if source exists
    if (!await fileExists(fullSourcePath)) {
      throw createNoteNotFoundError(sourcePath);
    }

    // Check if destination already exists
    if (await fileExists(fullDestPath)) {
      throw createNoteExistsError(destinationPath);
    }

    // Ensure destination directory exists
    const destDir = path.dirname(fullDestPath);
    await ensureDirectory(destDir);

    // Move the file
    await fs.rename(fullSourcePath, fullDestPath);

    // Update links in all markdown files
    const updatedFiles = await updateVaultLinks(vaultPath, sourcePath, destinationPath);

    return `Successfully moved note from "${sourcePath}" to "${destinationPath}"\n` +
           `Updated links in ${updatedFiles} file${updatedFiles === 1 ? '' : 's'}`;
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw handleFsError(error, 'move note');
  }
}

export function createMoveNoteTool(vaults: Map<string, string>): Tool {
  if (!vaults || vaults.size === 0) {
    throw new Error("At least one vault is required");
  }

  return {
    name: "move-note",
    description: "Move/rename a note while preserving links",
    inputSchema: schemaHandler,
    handler: async (args) => {
      try {
        const validated = schemaHandler.parse(args);
        const { vault, source, destination } = validated;
        
        const vaultPath = vaults.get(vault);
        if (!vaultPath) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Unknown vault: ${vault}. Available vaults: ${Array.from(vaults.keys()).join(', ')}`
          );
        }

        // Ensure .md extension
        const sourcePath = ensureMarkdownExtension(source);
        const destPath = ensureMarkdownExtension(destination);
        
        const resultMessage = await moveNote(vaultPath, sourcePath, destPath);
        
        return {
          content: [
            {
              type: "text",
              text: resultMessage
            }
          ]
        };
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Invalid arguments: ${error.errors.map(e => e.message).join(", ")}`
          );
        }
        throw error;
      }
    }
  };
}
