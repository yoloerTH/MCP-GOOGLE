import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Store user OAuth tokens (in production, use a database)
const userTokens = new Map<string, any>();

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
  'https://www.googleapis.com/auth/spreadsheets'
];

// OAuth routes
app.get('/oauth/start', (req, res) => {
  const userId = req.query.userId as string || 'default-user';
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    state: userId
  });
  res.redirect(authUrl);
});

app.get('/oauth/callback', async (req, res) => {
  const code = req.query.code as string;
  const userId = req.query.state as string || 'default-user';

  try {
    const { tokens } = await oauth2Client.getToken(code);
    userTokens.set(userId, tokens);
    res.send('✅ Authentication successful! You can close this window and return to n8n.');
  } catch (error) {
    res.status(500).send('❌ Authentication failed: ' + error);
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Google Workspace MCP Server' });
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
function getAuthenticatedClient(userId: string = 'default-user') {
  const tokens = userTokens.get(userId);
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
    const auth = getAuthenticatedClient(userId);

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
});
