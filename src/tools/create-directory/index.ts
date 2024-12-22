import { z } from "zod";
import { Tool } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

// Schema for directory creation
export const CreateDirectorySchema = z.object({
  path: z.string()
    .min(1, "Directory path cannot be empty")
    .refine(dirPath => !path.isAbsolute(dirPath), 
      "Directory path must be relative to vault root"),
  recursive: z.boolean()
    .optional()
    .default(true)
});

async function createDirectory(
  vaultPath: string,
  dirPath: string,
  recursive: boolean
): Promise<string> {
  const fullPath = path.join(vaultPath, dirPath);
  
  // Validate path is within vault
  const normalizedPath = path.normalize(fullPath);
  if (!normalizedPath.startsWith(path.normalize(vaultPath))) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Directory path must be within the vault directory"
    );
  }

  try {
    // Check if directory already exists
    try {
      await fs.access(normalizedPath);
      throw new McpError(
        ErrorCode.InvalidRequest,
        `A directory already exists at: ${normalizedPath}`
      );
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      // Directory doesn't exist, proceed with creation
      await fs.mkdir(normalizedPath, { recursive });
      return normalizedPath;
    }
  } catch (error: any) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to create directory: ${error.message}`
    );
  }
}

export function createCreateDirectoryTool(vaultPath: string): Tool {
  if (!vaultPath) {
    throw new Error("Vault path is required");
  }

  return {
    name: "create-directory",
    description: "Create a new directory in the vault",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path of the directory to create (relative to vault root)"
        },
        recursive: {
          type: "boolean",
          description: "Create parent directories if they don't exist (defaults to true)"
        }
      },
      required: ["path"]
    },
    handler: async (args) => {
      try {
        const { path: dirPath, recursive } = CreateDirectorySchema.parse(args);
        const createdPath = await createDirectory(vaultPath, dirPath, recursive);
        
        return {
          content: [
            {
              type: "text",
              text: `Successfully created directory at: ${createdPath}`
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
