// ============================================
// tools/taskTools.js — OpenAI Function Calling Definitions
// ============================================
// WHY THIS FILE?
// OpenAI's "function calling" lets the AI decide when to run
// a function. We define the tools here (what they do, what
// parameters they accept), and the AI calls them automatically
// when the user says something like "add a task to study math".
//
// HOW IT WORKS:
// 1. We send these tool definitions to OpenAI with every chat
// 2. The AI sees "oh, the user wants to create a task" and returns
//    a "tool_call" instead of a text reply
// 3. Our agent (mainAgent.js) catches the tool_call, runs the
//    actual function, and sends the result back to the AI
// 4. The AI then responds with a friendly confirmation
//
// FORMAT: Each tool follows OpenAI's JSON Schema format.
// ============================================

// -------------------------------------------------
// Tool definitions for OpenAI function calling
// -------------------------------------------------
const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'createTask',
      description:
        'Create a new task or to-do item for the user. Use when the user asks to add, create, or make a task, to-do, or item to their list.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short title of the task (e.g., "Finish math homework")',
          },
          description: {
            type: 'string',
            description: 'Optional longer description of the task',
          },
          priority: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'Priority level. Default: medium',
          },
          dueDate: {
            type: 'string',
            description: 'Due date in ISO 8601 format (e.g., "2024-12-31T23:59:00Z"). Optional.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags for organization (e.g., ["study", "math"])',
          },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getTasks',
      description:
        'Get the user\'s tasks. Use when the user asks to see, list, show, or check their tasks, to-dos, or schedule.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'in-progress', 'completed'],
            description: 'Filter by status. Omit to get all tasks.',
          },
          priority: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'Filter by priority. Omit to get all priorities.',
          },
          search: {
            type: 'string',
            description: 'Search keyword to filter tasks by title.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'updateTask',
      description:
        'Update an existing task (change status, title, priority, etc). Use when the user wants to mark a task as done, change its priority, or edit it.',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The MongoDB _id of the task to update.',
          },
          title: {
            type: 'string',
            description: 'New title for the task.',
          },
          status: {
            type: 'string',
            enum: ['pending', 'in-progress', 'completed'],
            description: 'New status for the task.',
          },
          priority: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'New priority for the task.',
          },
          dueDate: {
            type: 'string',
            description: 'New due date in ISO 8601 format.',
          },
        },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deleteTask',
      description:
        'Delete a task permanently. Use when the user asks to remove or delete a specific task.',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The MongoDB _id of the task to delete.',
          },
        },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'createReminder',
      description:
        'Set a reminder for the user. Use when the user asks to be reminded of something at a specific time.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'What to remind the user about (e.g., "Take medicine")',
          },
          reminderDate: {
            type: 'string',
            description: 'When to remind, in ISO 8601 format (e.g., "2024-12-25T09:00:00Z")',
          },
          description: {
            type: 'string',
            description: 'Optional extra details about the reminder.',
          },
        },
        required: ['title', 'reminderDate'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'saveMemory',
      description:
        'Save something to long-term memory about the user (a preference, fact, or important detail). Use when the user explicitly asks you to remember something.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The information to remember (e.g., "User prefers dark mode")',
          },
          metadata: {
            type: 'object',
            description: 'Optional metadata like { "topic": "preferences" }',
          },
        },
        required: ['content'],
      },
    },
  },
];

// -------------------------------------------------
// Map of tool names to actual service functions
// (filled in by mainAgent.js to avoid circular deps)
// -------------------------------------------------

module.exports = {
  toolDefinitions,
};

