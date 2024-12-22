import { z } from "zod";
import { Tool } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { fileExists, ensureDirectory } from "../../utils/files.js";
import { updateVaultLinks } from "../../utils/links.js";
import { createNoteExistsError, createNoteNotFoundError, handleFsError, handleZodError } from "../../utils/errors.js";

// Schema for move note operation
export const MoveNoteSchema = z.object({
  source: z.string()
    .min(1, "Source path cannot be empty")
    .refine(name => !path.isAbsolute(name), "Source must be a relative path"),
  destination: z.string()
    .min(1, "Destination path cannot be empty")
    .refine(name => !path.isAbsolute(name), "Destination must be a relative path")
});

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

export function createMoveNoteTool(vaultPath: string): Tool {
  if (!vaultPath) {
    throw new Error("Vault path is required");
  }

  return {
    name: "move-note",
    description: "Move/rename a note while preserving links",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Source path of the note relative to vault root (e.g., 'folder/note.md')"
        },
        destination: {
          type: "string",
          description: "Destination path relative to vault root (e.g., 'new-folder/new-name.md')"
        }
      },
      required: ["source", "destination"]
    },
    handler: async (args) => {
      try {
        const { source, destination } = MoveNoteSchema.parse(args);
        
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
          handleZodError(error);
        }
        throw error;
      }
    }
  };
}
