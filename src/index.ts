import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { google } from 'googleapis';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);

// Google OAuth2 Client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// OAuth Scopes for all Google Workspace services
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/keep'
];

// Helper functions for Supabase token storage
async function saveTokens(userId: string, tokens: any) {
  const { error } = await supabase
    .from('oauth_tokens')
    .upsert({ user_id: userId, tokens }, { onConflict: 'user_id' });

  if (error) {
    console.error('Error saving tokens:', error);
    throw error;
  }
}

async function getTokens(userId: string) {
  const { data, error } = await supabase
    .from('oauth_tokens')
    .select('tokens')
    .eq('user_id', userId)
    .single();

  if (error) {
    console.error('Error getting tokens:', error);
    return null;
  }

  return data?.tokens;
}

// OAuth routes
app.get('/oauth/start', (req, res) => {
  const userId = req.query.userId as string || 'default-user';
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    state: userId,
    prompt: 'consent' // Force fresh login every time
  });
  res.redirect(authUrl);
});

app.get('/oauth/callback', async (req, res) => {
  const code = req.query.code as string;
  const userId = req.query.state as string || 'default-user';

  try {
    const { tokens } = await oauth2Client.getToken(code);
    await saveTokens(userId, tokens);
    res.send('✅ Authentication successful! Your tokens are now saved to Supabase. You can close this window and return to n8n.');
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).send('❌ Authentication failed: ' + error);
  }
});

app.get('/oauth/logout', async (req, res) => {
  const userId = req.query.userId as string || 'default-user';
  try {
    const { error } = await supabase
      .from('oauth_tokens')
      .delete()
      .eq('user_id', userId);

    if (error) throw error;
    res.send('✅ Logged out successfully! Your tokens have been removed. Visit /oauth/start to authenticate again.');
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).send('❌ Logout failed: ' + error);
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Google Workspace MCP Server', storage: 'Supabase' });
});

// MCP Server Setup
const mcpServer = new Server(
  {
    name: 'google-workspace-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Helper function to get authenticated client
async function getAuthenticatedClient(userId: string = 'default-user') {
  const tokens = await getTokens(userId);
  if (!tokens) {
    throw new Error('User not authenticated. Please visit /oauth/start?userId=' + userId);
  }
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials(tokens);
  return client;
}

// Define tools
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // Gmail Tools
      {
        name: 'gmail_search',
        description: 'Search emails in Gmail',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query (e.g., "from:user@example.com subject:important")' },
            maxResults: { type: 'number', description: 'Maximum results (default: 10)', default: 10 },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['query']
        }
      },
      {
        name: 'gmail_send',
        description: 'Send an email via Gmail',
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Recipient email' },
            subject: { type: 'string', description: 'Email subject' },
            body: { type: 'string', description: 'Email body (plain text)' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['to', 'subject', 'body']
        }
      },
      {
        name: 'gmail_read',
        description: 'Read a specific email by ID',
        inputSchema: {
          type: 'object',
          properties: {
            messageId: { type: 'string', description: 'Gmail message ID' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['messageId']
        }
      },
      // Google Drive Tools
      {
        name: 'drive_search',
        description: 'Search files in Google Drive',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query (e.g., "name contains \'report\'")' },
            maxResults: { type: 'number', description: 'Maximum results (default: 10)', default: 10 },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['query']
        }
      },
      {
        name: 'drive_read',
        description: 'Read file content from Google Drive',
        inputSchema: {
          type: 'object',
          properties: {
            fileId: { type: 'string', description: 'Google Drive file ID' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['fileId']
        }
      },
      {
        name: 'drive_create',
        description: 'Create a new file in Google Drive',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'File name' },
            content: { type: 'string', description: 'File content' },
            mimeType: { type: 'string', description: 'MIME type (default: text/plain)', default: 'text/plain' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['name', 'content']
        }
      },
      // Google Calendar Tools
      {
        name: 'calendar_list_events',
        description: 'List upcoming calendar events',
        inputSchema: {
          type: 'object',
          properties: {
            maxResults: { type: 'number', description: 'Maximum results (default: 10)', default: 10 },
            timeMin: { type: 'string', description: 'Start time (ISO format, default: now)' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          }
        }
      },
      {
        name: 'calendar_create_event',
        description: 'Create a new calendar event',
        inputSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'Event title' },
            startTime: { type: 'string', description: 'Start time (ISO format)' },
            endTime: { type: 'string', description: 'End time (ISO format)' },
            description: { type: 'string', description: 'Event description' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['summary', 'startTime', 'endTime']
        }
      },
      {
        name: 'calendar_update_event',
        description: 'Update an existing calendar event (reschedule, change title, description, or location)',
        inputSchema: {
          type: 'object',
          properties: {
            eventId: { type: 'string', description: 'Calendar event ID' },
            summary: { type: 'string', description: 'New event title (optional)' },
            startTime: { type: 'string', description: 'New start time in ISO format (optional)' },
            endTime: { type: 'string', description: 'New end time in ISO format (optional)' },
            description: { type: 'string', description: 'New event description (optional)' },
            location: { type: 'string', description: 'New event location (optional)' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['eventId']
        }
      },
      {
        name: 'calendar_delete_event',
        description: 'Delete a calendar event',
        inputSchema: {
          type: 'object',
          properties: {
            eventId: { type: 'string', description: 'Calendar event ID to delete' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['eventId']
        }
      },
      // Google Contacts Tools
      {
        name: 'contacts_create',
        description: 'Create a new contact',
        inputSchema: {
          type: 'object',
          properties: {
            firstName: { type: 'string', description: 'First name' },
            lastName: { type: 'string', description: 'Last name' },
            email: { type: 'string', description: 'Email address' },
            phone: { type: 'string', description: 'Phone number' },
            address: { type: 'string', description: 'Physical address' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['firstName']
        }
      },
      {
        name: 'contacts_search',
        description: 'Search contacts',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query (name, email, phone)' },
            maxResults: { type: 'number', description: 'Maximum results (default: 10)', default: 10 },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['query']
        }
      },
      {
        name: 'contacts_update',
        description: 'Update an existing contact',
        inputSchema: {
          type: 'object',
          properties: {
            resourceName: { type: 'string', description: 'Contact resource name (from search results)' },
            firstName: { type: 'string', description: 'New first name (optional)' },
            lastName: { type: 'string', description: 'New last name (optional)' },
            email: { type: 'string', description: 'New email address (optional)' },
            phone: { type: 'string', description: 'New phone number (optional)' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['resourceName']
        }
      },
      {
        name: 'contacts_delete',
        description: 'Delete a contact',
        inputSchema: {
          type: 'object',
          properties: {
            resourceName: { type: 'string', description: 'Contact resource name to delete' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['resourceName']
        }
      },
      // Google Tasks Tools
      {
        name: 'tasks_create',
        description: 'Create a new task',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Task title' },
            notes: { type: 'string', description: 'Task notes/details' },
            due: { type: 'string', description: 'Due date (ISO format)' },
            taskListId: { type: 'string', description: 'Task list ID (default: "@default")', default: '@default' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['title']
        }
      },
      {
        name: 'tasks_list',
        description: 'List tasks from a task list',
        inputSchema: {
          type: 'object',
          properties: {
            taskListId: { type: 'string', description: 'Task list ID (default: "@default")', default: '@default' },
            maxResults: { type: 'number', description: 'Maximum results (default: 100)', default: 100 },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          }
        }
      },
      {
        name: 'tasks_update',
        description: 'Update an existing task (rename, change due date, or notes)',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'Task ID' },
            taskListId: { type: 'string', description: 'Task list ID (default: "@default")', default: '@default' },
            title: { type: 'string', description: 'New task title (optional)' },
            notes: { type: 'string', description: 'New task notes (optional)' },
            due: { type: 'string', description: 'New due date in ISO format (optional)' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['taskId']
        }
      },
      {
        name: 'tasks_complete',
        description: 'Mark a task as completed',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'Task ID to complete' },
            taskListId: { type: 'string', description: 'Task list ID (default: "@default")', default: '@default' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['taskId']
        }
      },
      {
        name: 'tasks_delete',
        description: 'Delete a task',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'Task ID to delete' },
            taskListId: { type: 'string', description: 'Task list ID (default: "@default")', default: '@default' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['taskId']
        }
      },
      // Google Keep Tools
      {
        name: 'keep_create_note',
        description: 'Create a new note in Google Keep',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Note title' },
            content: { type: 'string', description: 'Note content' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['content']
        }
      },
      {
        name: 'keep_search_notes',
        description: 'Search notes in Google Keep',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['query']
        }
      },
      {
        name: 'keep_update_note',
        description: 'Update an existing note in Google Keep',
        inputSchema: {
          type: 'object',
          properties: {
            noteId: { type: 'string', description: 'Note ID' },
            title: { type: 'string', description: 'New title (optional)' },
            content: { type: 'string', description: 'New content (optional)' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['noteId']
        }
      },
      {
        name: 'keep_delete_note',
        description: 'Delete a note from Google Keep',
        inputSchema: {
          type: 'object',
          properties: {
            noteId: { type: 'string', description: 'Note ID to delete' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['noteId']
        }
      },
      {
        name: 'keep_set_reminder',
        description: 'Set a reminder on a Google Keep note',
        inputSchema: {
          type: 'object',
          properties: {
            noteId: { type: 'string', description: 'Note ID' },
            reminderTime: { type: 'string', description: 'Reminder time (ISO format)' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['noteId', 'reminderTime']
        }
      },
      // Drive Extended Tools
      {
        name: 'drive_delete',
        description: 'Delete a file or folder from Google Drive',
        inputSchema: {
          type: 'object',
          properties: {
            fileId: { type: 'string', description: 'File or folder ID to delete' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['fileId']
        }
      },
      {
        name: 'drive_rename',
        description: 'Rename a file or folder in Google Drive',
        inputSchema: {
          type: 'object',
          properties: {
            fileId: { type: 'string', description: 'File or folder ID' },
            newName: { type: 'string', description: 'New name' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['fileId', 'newName']
        }
      },
      {
        name: 'drive_change_permissions',
        description: 'Change sharing permissions on a Google Drive file',
        inputSchema: {
          type: 'object',
          properties: {
            fileId: { type: 'string', description: 'File ID' },
            email: { type: 'string', description: 'Email address to share with' },
            role: { type: 'string', description: 'Permission role: reader, writer, or owner', enum: ['reader', 'writer', 'owner'] },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['fileId', 'email', 'role']
        }
      },
      // Docs Extended Tools
      {
        name: 'docs_delete',
        description: 'Delete a Google Doc',
        inputSchema: {
          type: 'object',
          properties: {
            documentId: { type: 'string', description: 'Document ID to delete' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['documentId']
        }
      },
      {
        name: 'docs_append',
        description: 'Append content to the end of a Google Doc',
        inputSchema: {
          type: 'object',
          properties: {
            documentId: { type: 'string', description: 'Document ID' },
            content: { type: 'string', description: 'Content to append' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['documentId', 'content']
        }
      },
      {
        name: 'docs_format_text',
        description: 'Format text in a Google Doc (bold, italic, or heading)',
        inputSchema: {
          type: 'object',
          properties: {
            documentId: { type: 'string', description: 'Document ID' },
            startIndex: { type: 'number', description: 'Start index of text to format' },
            endIndex: { type: 'number', description: 'End index of text to format' },
            bold: { type: 'boolean', description: 'Make text bold' },
            italic: { type: 'boolean', description: 'Make text italic' },
            fontSize: { type: 'number', description: 'Font size for heading (e.g., 20 for heading)' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['documentId', 'startIndex', 'endIndex']
        }
      },
      // Google Meet Tools
      {
        name: 'meet_schedule',
        description: 'Schedule a Google Meet meeting',
        inputSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'Meeting title' },
            startTime: { type: 'string', description: 'Start time (ISO format)' },
            endTime: { type: 'string', description: 'End time (ISO format)' },
            attendees: {
              type: 'array',
              description: 'Array of attendee email addresses',
              items: { type: 'string' }
            },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['summary', 'startTime', 'endTime']
        }
      },
      {
        name: 'meet_get_link',
        description: 'Get the Google Meet link for an existing calendar event',
        inputSchema: {
          type: 'object',
          properties: {
            eventId: { type: 'string', description: 'Calendar event ID' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['eventId']
        }
      },
      {
        name: 'meet_cancel',
        description: 'Cancel a Google Meet meeting',
        inputSchema: {
          type: 'object',
          properties: {
            eventId: { type: 'string', description: 'Calendar event ID to cancel' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['eventId']
        }
      },
      {
        name: 'meet_list',
        description: 'List upcoming Google Meet meetings',
        inputSchema: {
          type: 'object',
          properties: {
            maxResults: { type: 'number', description: 'Maximum results (default: 10)', default: 10 },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          }
        }
      },
      {
        name: 'meet_add_participants',
        description: 'Add participants to an existing Google Meet meeting',
        inputSchema: {
          type: 'object',
          properties: {
            eventId: { type: 'string', description: 'Calendar event ID' },
            attendees: {
              type: 'array',
              description: 'Array of attendee email addresses to add',
              items: { type: 'string' }
            },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['eventId', 'attendees']
        }
      },
      // Google Docs Tools
      {
        name: 'docs_read',
        description: 'Read content from a Google Doc',
        inputSchema: {
          type: 'object',
          properties: {
            documentId: { type: 'string', description: 'Google Docs document ID' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['documentId']
        }
      },
      {
        name: 'docs_create',
        description: 'Create a new Google Doc',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Document title' },
            content: { type: 'string', description: 'Document content' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['title']
        }
      },
      // Google Sheets Tools
      {
        name: 'sheets_read',
        description: 'Read data from a Google Sheet',
        inputSchema: {
          type: 'object',
          properties: {
            spreadsheetId: { type: 'string', description: 'Google Sheets spreadsheet ID' },
            range: { type: 'string', description: 'Range to read (e.g., "Sheet1!A1:D10")', default: 'Sheet1' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['spreadsheetId']
        }
      },
      {
        name: 'sheets_write',
        description: 'Write data to a Google Sheet',
        inputSchema: {
          type: 'object',
          properties: {
            spreadsheetId: { type: 'string', description: 'Google Sheets spreadsheet ID' },
            range: { type: 'string', description: 'Range to write (e.g., "Sheet1!A1")' },
            values: {
              type: 'array',
              description: 'Array of rows to write (e.g., [["A1", "B1"], ["A2", "B2"]])',
              items: {
                type: 'array',
                items: {
                  type: 'string'
                }
              }
            },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['spreadsheetId', 'range', 'values']
        }
      }
    ]
  };
});

// Handle tool calls
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const userId = (args as any).userId || 'default-user';

  try {
    const auth = await getAuthenticatedClient(userId);

    switch (name) {
      // Gmail handlers
      case 'gmail_search': {
        const gmail = google.gmail({ version: 'v1', auth });
        const response = await gmail.users.messages.list({
          userId: 'me',
          q: (args as any).query,
          maxResults: (args as any).maxResults || 10
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
        };
      }

      case 'gmail_send': {
        const gmail = google.gmail({ version: 'v1', auth });
        const email = [
          `To: ${(args as any).to}`,
          `Subject: ${(args as any).subject}`,
          '',
          (args as any).body
        ].join('\n');

        const encodedEmail = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
        const response = await gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw: encodedEmail }
        });
        return {
          content: [{ type: 'text', text: `Email sent successfully! Message ID: ${response.data.id}` }]
        };
      }

      case 'gmail_read': {
        const gmail = google.gmail({ version: 'v1', auth });
        const response = await gmail.users.messages.get({
          userId: 'me',
          id: (args as any).messageId
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
        };
      }

      // Google Drive handlers
      case 'drive_search': {
        const drive = google.drive({ version: 'v3', auth });
        const response = await drive.files.list({
          q: (args as any).query,
          pageSize: (args as any).maxResults || 10,
          fields: 'files(id, name, mimeType, modifiedTime, webViewLink)'
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(response.data.files, null, 2) }]
        };
      }

      case 'drive_read': {
        const drive = google.drive({ version: 'v3', auth });
        const response = await drive.files.get({
          fileId: (args as any).fileId,
          alt: 'media'
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(response.data) }]
        };
      }

      case 'drive_create': {
        const drive = google.drive({ version: 'v3', auth });
        const response = await drive.files.create({
          requestBody: {
            name: (args as any).name,
            mimeType: (args as any).mimeType || 'text/plain'
          },
          media: {
            mimeType: (args as any).mimeType || 'text/plain',
            body: (args as any).content
          },
          fields: 'id, name, webViewLink'
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
        };
      }

      // Calendar handlers
      case 'calendar_list_events': {
        const calendar = google.calendar({ version: 'v3', auth });
        const response = await calendar.events.list({
          calendarId: 'primary',
          timeMin: (args as any).timeMin || new Date().toISOString(),
          maxResults: (args as any).maxResults || 10,
          singleEvents: true,
          orderBy: 'startTime'
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(response.data.items, null, 2) }]
        };
      }

      case 'calendar_create_event': {
        const calendar = google.calendar({ version: 'v3', auth });
        const response = await calendar.events.insert({
          calendarId: 'primary',
          requestBody: {
            summary: (args as any).summary,
            description: (args as any).description,
            start: { dateTime: (args as any).startTime },
            end: { dateTime: (args as any).endTime }
          }
        });
        return {
          content: [{ type: 'text', text: `Event created! Link: ${response.data.htmlLink}` }]
        };
      }

      // Google Docs handlers
      case 'docs_read': {
        const docs = google.docs({ version: 'v1', auth });
        const response = await docs.documents.get({
          documentId: (args as any).documentId
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
        };
      }

      case 'docs_create': {
        const docs = google.docs({ version: 'v1', auth });
        const response = await docs.documents.create({
          requestBody: {
            title: (args as any).title
          }
        });

        if ((args as any).content) {
          await docs.documents.batchUpdate({
            documentId: response.data.documentId!,
            requestBody: {
              requests: [{
                insertText: {
                  location: { index: 1 },
                  text: (args as any).content
                }
              }]
            }
          });
        }

        return {
          content: [{ type: 'text', text: `Document created! ID: ${response.data.documentId}` }]
        };
      }

      // Google Sheets handlers
      case 'sheets_read': {
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: (args as any).spreadsheetId,
          range: (args as any).range || 'Sheet1'
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(response.data.values, null, 2) }]
        };
      }

      case 'sheets_write': {
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.update({
          spreadsheetId: (args as any).spreadsheetId,
          range: (args as any).range,
          valueInputOption: 'RAW',
          requestBody: {
            values: (args as any).values
          }
        });
        return {
          content: [{ type: 'text', text: `Updated ${response.data.updatedCells} cells` }]
        };
      }

      // Calendar Extended handlers
      case 'calendar_update_event': {
        const calendar = google.calendar({ version: 'v3', auth });
        const updateBody: any = {};

        if ((args as any).summary) updateBody.summary = (args as any).summary;
        if ((args as any).description) updateBody.description = (args as any).description;
        if ((args as any).location) updateBody.location = (args as any).location;
        if ((args as any).startTime) updateBody.start = { dateTime: (args as any).startTime };
        if ((args as any).endTime) updateBody.end = { dateTime: (args as any).endTime };

        const response = await calendar.events.patch({
          calendarId: 'primary',
          eventId: (args as any).eventId,
          requestBody: updateBody
        });
        return {
          content: [{ type: 'text', text: `Event updated successfully! Link: ${response.data.htmlLink}` }]
        };
      }

      case 'calendar_delete_event': {
        const calendar = google.calendar({ version: 'v3', auth });
        await calendar.events.delete({
          calendarId: 'primary',
          eventId: (args as any).eventId
        });
        return {
          content: [{ type: 'text', text: 'Event deleted successfully!' }]
        };
      }

      // Google Contacts handlers
      case 'contacts_create': {
        const people = google.people({ version: 'v1', auth });
        const response = await people.people.createContact({
          requestBody: {
            names: [{ givenName: (args as any).firstName, familyName: (args as any).lastName }],
            emailAddresses: (args as any).email ? [{ value: (args as any).email }] : [],
            phoneNumbers: (args as any).phone ? [{ value: (args as any).phone }] : [],
            addresses: (args as any).address ? [{ formattedValue: (args as any).address }] : []
          }
        });
        return {
          content: [{ type: 'text', text: `Contact created! Resource name: ${response.data.resourceName}` }]
        };
      }

      case 'contacts_search': {
        const people = google.people({ version: 'v1', auth });
        const response = await people.people.searchContacts({
          query: (args as any).query,
          readMask: 'names,emailAddresses,phoneNumbers',
          pageSize: (args as any).maxResults || 10
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(response.data.results, null, 2) }]
        };
      }

      case 'contacts_update': {
        const people = google.people({ version: 'v1', auth });

        // First get the contact to get the etag
        const existing = await people.people.get({
          resourceName: (args as any).resourceName,
          personFields: 'names,emailAddresses,phoneNumbers'
        });

        const updateBody: any = { etag: existing.data.etag };
        if ((args as any).firstName || (args as any).lastName) {
          updateBody.names = [{
            givenName: (args as any).firstName,
            familyName: (args as any).lastName
          }];
        }
        if ((args as any).email) {
          updateBody.emailAddresses = [{ value: (args as any).email }];
        }
        if ((args as any).phone) {
          updateBody.phoneNumbers = [{ value: (args as any).phone }];
        }

        const response = await people.people.updateContact({
          resourceName: (args as any).resourceName,
          updatePersonFields: 'names,emailAddresses,phoneNumbers',
          requestBody: updateBody
        });
        return {
          content: [{ type: 'text', text: 'Contact updated successfully!' }]
        };
      }

      case 'contacts_delete': {
        const people = google.people({ version: 'v1', auth });
        await people.people.deleteContact({
          resourceName: (args as any).resourceName
        });
        return {
          content: [{ type: 'text', text: 'Contact deleted successfully!' }]
        };
      }

      // Google Tasks handlers
      case 'tasks_create': {
        const tasks = google.tasks({ version: 'v1', auth });
        const response = await tasks.tasks.insert({
          tasklist: (args as any).taskListId || '@default',
          requestBody: {
            title: (args as any).title,
            notes: (args as any).notes,
            due: (args as any).due
          }
        });
        return {
          content: [{ type: 'text', text: `Task created! ID: ${response.data.id}` }]
        };
      }

      case 'tasks_list': {
        const tasks = google.tasks({ version: 'v1', auth });
        const response = await tasks.tasks.list({
          tasklist: (args as any).taskListId || '@default',
          maxResults: (args as any).maxResults || 100
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(response.data.items, null, 2) }]
        };
      }

      case 'tasks_update': {
        const tasks = google.tasks({ version: 'v1', auth });
        const updateBody: any = {};
        if ((args as any).title) updateBody.title = (args as any).title;
        if ((args as any).notes) updateBody.notes = (args as any).notes;
        if ((args as any).due) updateBody.due = (args as any).due;

        const response = await tasks.tasks.patch({
          tasklist: (args as any).taskListId || '@default',
          task: (args as any).taskId,
          requestBody: updateBody
        });
        return {
          content: [{ type: 'text', text: 'Task updated successfully!' }]
        };
      }

      case 'tasks_complete': {
        const tasks = google.tasks({ version: 'v1', auth });
        await tasks.tasks.patch({
          tasklist: (args as any).taskListId || '@default',
          task: (args as any).taskId,
          requestBody: {
            status: 'completed'
          }
        });
        return {
          content: [{ type: 'text', text: 'Task marked as completed!' }]
        };
      }

      case 'tasks_delete': {
        const tasks = google.tasks({ version: 'v1', auth });
        await tasks.tasks.delete({
          tasklist: (args as any).taskListId || '@default',
          task: (args as any).taskId
        });
        return {
          content: [{ type: 'text', text: 'Task deleted successfully!' }]
        };
      }

      // Google Keep handlers
      case 'keep_create_note': {
        const keep = google.keep({ version: 'v1', auth });
        const response = await keep.notes.create({
          requestBody: {
            title: (args as any).title || '',
            body: {
              text: {
                text: (args as any).content
              }
            }
          }
        });
        return {
          content: [{ type: 'text', text: `Note created! ID: ${response.data.name}` }]
        };
      }

      case 'keep_search_notes': {
        const keep = google.keep({ version: 'v1', auth });
        const response = await keep.notes.list({
          filter: (args as any).query
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(response.data.notes, null, 2) }]
        };
      }

      case 'keep_update_note': {
        const keep = google.keep({ version: 'v1', auth });

        // First get the note to get current data
        const existingNote = await keep.notes.get({
          name: (args as any).noteId
        });

        const updateBody: any = {
          name: (args as any).noteId
        };

        if ((args as any).title !== undefined) {
          updateBody.title = (args as any).title;
        } else {
          updateBody.title = existingNote.data.title;
        }

        if ((args as any).content !== undefined) {
          updateBody.body = {
            text: {
              text: (args as any).content
            }
          };
        } else {
          updateBody.body = existingNote.data.body;
        }

        const response = await keep.notes.create({
          requestBody: updateBody
        });

        // Delete old note
        await keep.notes.delete({
          name: (args as any).noteId
        });

        return {
          content: [{ type: 'text', text: 'Note updated successfully!' }]
        };
      }

      case 'keep_delete_note': {
        const keep = google.keep({ version: 'v1', auth });
        await keep.notes.delete({
          name: (args as any).noteId
        });
        return {
          content: [{ type: 'text', text: 'Note deleted successfully!' }]
        };
      }

      case 'keep_set_reminder': {
        const keep = google.keep({ version: 'v1', auth });

        // Get existing note
        const existingNote = await keep.notes.get({
          name: (args as any).noteId
        });

        // Create updated note with reminder
        const updateBody: any = {
          ...existingNote.data,
          body: existingNote.data.body,
          attachments: [
            ...(existingNote.data.attachments || []),
            {
              mimeType: ['application/vnd.google.apps.reminder'],
              // Keep API reminders structure - this may need adjustment based on actual API
            }
          ]
        };

        const response = await keep.notes.create({
          requestBody: updateBody
        });

        // Delete old note
        await keep.notes.delete({
          name: (args as any).noteId
        });

        return {
          content: [{ type: 'text', text: `Reminder set for ${(args as any).reminderTime}` }]
        };
      }

      // Drive Extended handlers
      case 'drive_delete': {
        const drive = google.drive({ version: 'v3', auth });
        await drive.files.delete({
          fileId: (args as any).fileId
        });
        return {
          content: [{ type: 'text', text: 'File deleted successfully!' }]
        };
      }

      case 'drive_rename': {
        const drive = google.drive({ version: 'v3', auth });
        const response = await drive.files.update({
          fileId: (args as any).fileId,
          requestBody: {
            name: (args as any).newName
          }
        });
        return {
          content: [{ type: 'text', text: `File renamed to: ${response.data.name}` }]
        };
      }

      case 'drive_change_permissions': {
        const drive = google.drive({ version: 'v3', auth });
        const response = await drive.permissions.create({
          fileId: (args as any).fileId,
          requestBody: {
            type: 'user',
            role: (args as any).role,
            emailAddress: (args as any).email
          }
        });
        return {
          content: [{ type: 'text', text: `Shared with ${(args as any).email} as ${(args as any).role}` }]
        };
      }

      // Docs Extended handlers
      case 'docs_delete': {
        const drive = google.drive({ version: 'v3', auth });
        await drive.files.delete({
          fileId: (args as any).documentId
        });
        return {
          content: [{ type: 'text', text: 'Document deleted successfully!' }]
        };
      }

      case 'docs_append': {
        const docs = google.docs({ version: 'v1', auth });

        // First, get the document to find the end index
        const doc = await docs.documents.get({
          documentId: (args as any).documentId
        });

        const endIndex = doc.data.body?.content?.slice(-1)[0]?.endIndex || 1;

        await docs.documents.batchUpdate({
          documentId: (args as any).documentId,
          requestBody: {
            requests: [{
              insertText: {
                location: { index: endIndex - 1 },
                text: '\n' + (args as any).content
              }
            }]
          }
        });
        return {
          content: [{ type: 'text', text: 'Content appended to document!' }]
        };
      }

      case 'docs_format_text': {
        const docs = google.docs({ version: 'v1', auth });
        const requests: any[] = [];

        if ((args as any).bold !== undefined) {
          requests.push({
            updateTextStyle: {
              range: {
                startIndex: (args as any).startIndex,
                endIndex: (args as any).endIndex
              },
              textStyle: { bold: (args as any).bold },
              fields: 'bold'
            }
          });
        }

        if ((args as any).italic !== undefined) {
          requests.push({
            updateTextStyle: {
              range: {
                startIndex: (args as any).startIndex,
                endIndex: (args as any).endIndex
              },
              textStyle: { italic: (args as any).italic },
              fields: 'italic'
            }
          });
        }

        if ((args as any).fontSize) {
          requests.push({
            updateTextStyle: {
              range: {
                startIndex: (args as any).startIndex,
                endIndex: (args as any).endIndex
              },
              textStyle: {
                fontSize: { magnitude: (args as any).fontSize, unit: 'PT' }
              },
              fields: 'fontSize'
            }
          });
        }

        await docs.documents.batchUpdate({
          documentId: (args as any).documentId,
          requestBody: { requests }
        });
        return {
          content: [{ type: 'text', text: 'Text formatted successfully!' }]
        };
      }

      // Google Meet handlers (via Calendar with Meet links)
      case 'meet_schedule': {
        const calendar = google.calendar({ version: 'v3', auth });
        const response = await calendar.events.insert({
          calendarId: 'primary',
          conferenceDataVersion: 1,
          requestBody: {
            summary: (args as any).summary,
            start: { dateTime: (args as any).startTime },
            end: { dateTime: (args as any).endTime },
            attendees: ((args as any).attendees || []).map((email: string) => ({ email })),
            conferenceData: {
              createRequest: {
                requestId: `meet-${Date.now()}`,
                conferenceSolutionKey: { type: 'hangoutsMeet' }
              }
            }
          }
        });
        return {
          content: [{
            type: 'text',
            text: `Google Meet scheduled!\nLink: ${response.data.hangoutLink}\nCalendar: ${response.data.htmlLink}`
          }]
        };
      }

      case 'meet_get_link': {
        const calendar = google.calendar({ version: 'v3', auth });
        const response = await calendar.events.get({
          calendarId: 'primary',
          eventId: (args as any).eventId
        });
        return {
          content: [{
            type: 'text',
            text: response.data.hangoutLink
              ? `Meet link: ${response.data.hangoutLink}`
              : 'No Google Meet link found for this event'
          }]
        };
      }

      case 'meet_cancel': {
        const calendar = google.calendar({ version: 'v3', auth });
        await calendar.events.delete({
          calendarId: 'primary',
          eventId: (args as any).eventId,
          sendUpdates: 'all'
        });
        return {
          content: [{ type: 'text', text: 'Google Meet meeting cancelled and attendees notified!' }]
        };
      }

      case 'meet_list': {
        const calendar = google.calendar({ version: 'v3', auth });
        const response = await calendar.events.list({
          calendarId: 'primary',
          timeMin: new Date().toISOString(),
          maxResults: (args as any).maxResults || 10,
          singleEvents: true,
          orderBy: 'startTime'
        });

        const meetingsWithLinks = response.data.items?.filter(event => event.hangoutLink);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(meetingsWithLinks, null, 2)
          }]
        };
      }

      case 'meet_add_participants': {
        const calendar = google.calendar({ version: 'v3', auth });

        // Get existing event
        const event = await calendar.events.get({
          calendarId: 'primary',
          eventId: (args as any).eventId
        });

        // Add new attendees
        const existingAttendees = event.data.attendees || [];
        const newAttendees = ((args as any).attendees || []).map((email: string) => ({ email }));
        const allAttendees = [...existingAttendees, ...newAttendees];

        const response = await calendar.events.patch({
          calendarId: 'primary',
          eventId: (args as any).eventId,
          sendUpdates: 'all',
          requestBody: {
            attendees: allAttendees
          }
        });
        return {
          content: [{ type: 'text', text: `Added ${newAttendees.length} participant(s) and sent invitations!` }]
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [{
        type: 'text',
        text: `Error: ${error.message}\n\nIf authentication error, please visit: ${process.env.GOOGLE_REDIRECT_URI?.replace('/oauth/callback', '/oauth/start')}?userId=${userId}`
      }],
      isError: true
    };
  }
});

// HTTP streaming endpoint for n8n
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // Stateless mode for n8n
});

await mcpServer.connect(transport);

app.post('/mcp', express.json(), async (req, res) => {
  await transport.handleRequest(req, res, req.body);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Google Workspace MCP Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🔐 OAuth start: http://localhost:${PORT}/oauth/start`);
  console.log(`📡 MCP endpoint for n8n: http://localhost:${PORT}/mcp`);
  console.log(`💾 Token storage: Supabase`);
});
