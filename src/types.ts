export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
  handler: (args: any) => Promise<{
    content: Array<{
      type: string;
      text: string;
    }>;
  }>;
}

export interface ToolProvider {
  getTools(): Tool[];
}
