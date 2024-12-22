import { z } from "zod";
import { Tool } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { fileExists, ensureDirectory } from "../../utils/files.js";
import { updateVaultLinks } from "../../utils/links.js";
import { createNoteNotFoundError, handleFsError } from "../../utils/errors.js";
import { createSchemaHandler } from "../../utils/schema.js";

// Input validation schema with descriptions
const schema = z.object({
  path: z.string()
    .min(1, "Path cannot be empty")
    .refine(name => !path.isAbsolute(name), 
      "Path must be relative to vault root")
    .describe("Path of the note relative to vault root (e.g., 'folder/note.md')"),
  reason: z.string()
    .optional()
    .describe("Optional reason for deletion (stored in trash metadata)"),
  permanent: z.boolean()
    .optional()
    .default(false)
    .describe("Whether to permanently delete instead of moving to trash (default: false)")
}).strict();

// Create schema handler that provides both Zod validation and JSON Schema
const schemaHandler = createSchemaHandler(schema);

interface TrashMetadata {
  originalPath: string;
  deletedAt: string;
  reason?: string;
}

async function ensureTrashDirectory(vaultPath: string): Promise<string> {
  const trashPath = path.join(vaultPath, ".trash");
  await ensureDirectory(trashPath);
  return trashPath;
}

async function moveToTrash(
  vaultPath: string,
  notePath: string,
  reason?: string
): Promise<string> {
  const trashPath = await ensureTrashDirectory(vaultPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const trashName = `${path.basename(notePath, ".md")}_${timestamp}.md`;
  const trashFilePath = path.join(trashPath, trashName);

  // Create metadata
  const metadata: TrashMetadata = {
    originalPath: notePath,
    deletedAt: new Date().toISOString(),
    reason
  };

  try {
    // Read original content
    const content = await fs.readFile(path.join(vaultPath, notePath), "utf-8");
    
    // Prepend metadata as YAML frontmatter
    const contentWithMetadata = `---
trash_metadata:
  original_path: ${metadata.originalPath}
  deleted_at: ${metadata.deletedAt}${reason ? `\n  reason: ${reason}` : ""}
---

${content}`;

    // Write to trash with metadata
    await fs.writeFile(trashFilePath, contentWithMetadata);
    
    // Delete original file
    await fs.unlink(path.join(vaultPath, notePath));

    return trashName;
  } catch (error) {
    throw handleFsError(error, 'move note to trash');
  }
}

async function deleteNote(
  vaultPath: string,
  notePath: string,
  options: {
    permanent?: boolean;
    reason?: string;
  } = {}
): Promise<string> {
  const fullPath = path.join(vaultPath, notePath);

  // Validate path is within vault
  validateVaultPath(vaultPath, fullPath);

  try {
    // Check if note exists
    if (!await fileExists(fullPath)) {
      throw createNoteNotFoundError(notePath);
    }

    // Update links in other files first
    const updatedFiles = await updateVaultLinks(vaultPath, notePath, null);
    
    if (options.permanent) {
      // Permanently delete the file
      await fs.unlink(fullPath);
      return `Permanently deleted note "${notePath}"\n` +
             `Updated ${updatedFiles} file${updatedFiles === 1 ? '' : 's'} with broken links`;
    } else {
      // Move to trash with metadata
      const trashName = await moveToTrash(vaultPath, notePath, options.reason);
      return `Moved note "${notePath}" to trash as "${trashName}"\n` +
             `Updated ${updatedFiles} file${updatedFiles === 1 ? '' : 's'} with broken links`;
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw handleFsError(error, 'delete note');
  }
}

export function createDeleteNoteTool(vaultPath: string): Tool {
  if (!vaultPath) {
    throw new Error("Vault path is required");
  }

  return {
    name: "delete-note",
    description: "Delete a note, moving it to .trash by default or permanently deleting if specified",
    inputSchema: schemaHandler,
    handler: async (args) => {
      try {
        const validated = schemaHandler.parse(args);
        const { path: notePath, reason, permanent } = validated;
        
        // Ensure .md extension
        const fullNotePath = ensureMarkdownExtension(notePath);
        
        const resultMessage = await deleteNote(vaultPath, fullNotePath, { reason, permanent });
        
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
