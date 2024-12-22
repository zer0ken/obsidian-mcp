import { z } from "zod";

// Base interfaces for tool structure
export interface SchemaHandler<T> {
  jsonSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
  parse: (input: unknown) => T;
}

export interface Tool<TInput = any> {
  name: string;
  description: string;
  inputSchema: SchemaHandler<TInput>;
  handler: (args: TInput) => Promise<ToolResponse>;
}

export interface ToolResponse {
  content: Array<{
    type: string;
    text: string;
  }>;
}

// Common operation result types
export interface OperationResult {
  success: boolean;
  message: string;
  details?: Record<string, any>;
}

export interface BatchOperationResult extends OperationResult {
  successCount: number;
  totalCount: number;
  failedItems: Array<{
    item: string;
    error: string;
  }>;
}

// File operation specific types
export interface FileOperationResult extends OperationResult {
  path: string;
  operation: 'create' | 'edit' | 'delete' | 'move';
}

// Tag operation specific types
export interface TagChange {
  tag: string;
  location: 'frontmatter' | 'content';
  line?: number;
  context?: string;
}

export interface TagOperationResult extends BatchOperationResult {
  details: {
    [filename: string]: {
      changes: TagChange[];
    };
  };
}

// Search operation specific types
export interface SearchMatch {
  line: number;
  text: string;
}

export interface SearchResult {
  file: string;
  matches: SearchMatch[];
}

export interface SearchOperationResult extends OperationResult {
  results: SearchResult[];
  totalMatches: number;
  matchedFiles: number;
}

// Common option types
export interface TagOperationOptions {
  location?: 'frontmatter' | 'content' | 'both';
  normalize?: boolean;
  position?: 'start' | 'end';
  preserveChildren?: boolean;
  patterns?: string[];
}

export interface SearchOptions {
  caseSensitive?: boolean;
  searchType?: 'content' | 'filename' | 'both';
  path?: string;
}
