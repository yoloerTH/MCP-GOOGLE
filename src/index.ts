import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// CORS Configuration - Allow requests from frontend
app.use(cors({
  origin: [
    'https://naurra.ai',
    'https://www.naurra.ai',
    'https://googleassistantai.netlify.app',
    'https://voicecallai.netlify.app',
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

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
  'https://www.googleapis.com/auth/tasks'
];

// ========================================
// CUSTOM ERROR CLASSES
// ========================================

class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

class TemporaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemporaryError';
  }
}

// ========================================
// ENHANCED TOKEN MANAGEMENT
// ========================================

// Helper function to save tokens
async function saveTokens(userId: string, tokens: any) {
  const { error } = await supabase
    .from('oauth_tokens')
    .upsert({ user_id: userId, tokens }, { onConflict: 'user_id' });

  if (error) {
    console.error('Error saving tokens:', error);
    throw error;
  }
}

// Enhanced token retrieval with retry logic and proper error classification
async function getTokens(userId: string, retries = 3): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data, error } = await supabase
        .from('oauth_tokens')
        .select('tokens')
        .eq('user_id', userId)
        .single();

      if (error) {
        // PGRST116 = Row not found (user truly not authenticated)
        if (error.code === 'PGRST116') {
          console.log(`User ${userId} not found in database (not authenticated)`);
          return null;
        }

        // Network/timeout error - retry with exponential backoff
        console.warn(`Supabase error on attempt ${attempt}/${retries}:`, error.message);

        if (attempt === retries) {
          throw new TemporaryError('Database temporarily unavailable. Please try again in a moment.');
        }

        // Exponential backoff: 1s, 2s, 3s
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        continue;
      }

      // Success - return tokens
      console.log(`✅ Successfully retrieved tokens for user ${userId}`);
      return data?.tokens;

    } catch (err: any) {
      console.error(`Unexpected error retrieving tokens (attempt ${attempt}/${retries}):`, err);

      if (attempt === retries) {
        throw new TemporaryError('Unable to retrieve authentication tokens. Please try again.');
      }

      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }

  return null;
}

// Enhanced authentication with token refresh
async function getAuthenticatedClient(userId: string = 'default-user') {
  const tokens = await getTokens(userId);

  if (!tokens) {
    const authUrl = `${process.env.GOOGLE_REDIRECT_URI?.replace('/oauth/callback', '/oauth/start')}?userId=${userId}`;
    throw new AuthenticationError(`User not authenticated. Please visit: ${authUrl}`);
  }

  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  client.setCredentials(tokens);

  // Check if access token is expired and refresh if needed
  if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
    console.log(`🔄 Access token expired for user ${userId}, refreshing...`);

    try {
      const { credentials } = await client.refreshAccessToken();
      console.log(`✅ Token refreshed successfully for user ${userId}`);

      // Save refreshed tokens
      await saveTokens(userId, credentials);
      client.setCredentials(credentials);
    } catch (refreshError: any) {
      console.error('Token refresh failed:', refreshError.message);
      const authUrl = `${process.env.GOOGLE_REDIRECT_URI?.replace('/oauth/callback', '/oauth/start')}?userId=${userId}`;
      throw new AuthenticationError(`Token expired and refresh failed. Please re-authenticate at: ${authUrl}`);
    }
  }

  return client;
}

// ========================================
// SMART SEARCH HELPER
// ========================================

// Smart Drive search with multiple fallback strategies
async function smartDriveSearch(auth: any, query: string, maxResults: number = 10) {
  const drive = google.drive({ version: 'v3', auth });

  console.log(`🔍 Starting smart search with query: "${query}"`);

  // Strategy 1: Try the original query as-is
  try {
    const results = await drive.files.list({
      q: query,
      pageSize: maxResults,
      fields: 'files(id, name, mimeType, modifiedTime, webViewLink, owners)'
    });

    if (results.data.files && results.data.files.length > 0) {
      console.log(`✅ Strategy 1 (exact query) found ${results.data.files.length} results`);
      return results.data.files;
    }
  } catch (error: any) {
    console.warn('Strategy 1 failed:', error.message);
  }

  // Strategy 2: Extract search term and try case-insensitive contains
  const searchTermMatch = query.match(/name contains ['"](.+?)['"]/i);
  if (searchTermMatch) {
    const term = searchTermMatch[1];
    console.log(`📝 Extracted search term: "${term}"`);

    // Try lowercase
    try {
      const results = await drive.files.list({
        q: `name contains '${term.toLowerCase()}'`,
        pageSize: maxResults,
        fields: 'files(id, name, mimeType, modifiedTime, webViewLink, owners)'
      });

      if (results.data.files && results.data.files.length > 0) {
        console.log(`✅ Strategy 2 (lowercase) found ${results.data.files.length} results`);
        return results.data.files;
      }
    } catch (error: any) {
      console.warn('Strategy 2 (lowercase) failed:', error.message);
    }

    // Try uppercase
    try {
      const results = await drive.files.list({
        q: `name contains '${term.toUpperCase()}'`,
        pageSize: maxResults,
        fields: 'files(id, name, mimeType, modifiedTime, webViewLink, owners)'
      });

      if (results.data.files && results.data.files.length > 0) {
        console.log(`✅ Strategy 3 (uppercase) found ${results.data.files.length} results`);
        return results.data.files;
      }
    } catch (error: any) {
      console.warn('Strategy 3 (uppercase) failed:', error.message);
    }

    // Strategy 3: Try partial match (first 4+ characters)
    if (term.length >= 4) {
      try {
        const partialTerm = term.substring(0, Math.max(4, Math.floor(term.length * 0.6)));
        const results = await drive.files.list({
          q: `name contains '${partialTerm.toLowerCase()}'`,
          pageSize: maxResults * 3, // Get more results for fuzzy matching
          fields: 'files(id, name, mimeType, modifiedTime, webViewLink, owners)'
        });

        // Filter results that contain the original search term (case-insensitive)
        if (results.data.files) {
          const filtered = results.data.files.filter(file =>
            file.name?.toLowerCase().includes(term.toLowerCase())
          );

          if (filtered.length > 0) {
            console.log(`✅ Strategy 4 (partial match) found ${filtered.length} results`);
            return filtered.slice(0, maxResults);
          }
        }
      } catch (error: any) {
        console.warn('Strategy 4 (partial) failed:', error.message);
      }
    }

    // Strategy 4: Try searching in Google Docs specifically
    try {
      const results = await drive.files.list({
        q: `name contains '${term.toLowerCase()}' and mimeType='application/vnd.google-apps.document'`,
        pageSize: maxResults,
        fields: 'files(id, name, mimeType, modifiedTime, webViewLink, owners)'
      });

      if (results.data.files && results.data.files.length > 0) {
        console.log(`✅ Strategy 5 (Docs-specific) found ${results.data.files.length} results`);
        return results.data.files;
      }
    } catch (error: any) {
      console.warn('Strategy 5 (Docs) failed:', error.message);
    }

    // Strategy 5: Try searching in Google Sheets
    try {
      const results = await drive.files.list({
        q: `name contains '${term.toLowerCase()}' and mimeType='application/vnd.google-apps.spreadsheet'`,
        pageSize: maxResults,
        fields: 'files(id, name, mimeType, modifiedTime, webViewLink, owners)'
      });

      if (results.data.files && results.data.files.length > 0) {
        console.log(`✅ Strategy 6 (Sheets-specific) found ${results.data.files.length} results`);
        return results.data.files;
      }
    } catch (error: any) {
      console.warn('Strategy 6 (Sheets) failed:', error.message);
    }
  }

  console.log('❌ All search strategies exhausted - no results found');
  return [];
}

// ========================================
// OAUTH ROUTES
// ========================================

app.get('/oauth/start', (req, res) => {
  const userId = req.query.userId as string;

  if (!userId) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Missing User ID</title>
          <style>
            body { font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px; }
            h1 { color: #dc2626; }
            code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }
          </style>
        </head>
        <body>
          <h1>❌ Error: userId parameter is required</h1>
          <p>This endpoint expects a Supabase user ID to link Google Workspace credentials.</p>
          <p><strong>Example:</strong> <code>/oauth/start?userId=abc123-def456-ghi789</code></p>
          <p>If you're using the frontend app, this should happen automatically after you sign in.</p>
        </body>
      </html>
    `);
  }

  console.log(`🔐 Starting OAuth flow for user: ${userId}`);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    state: userId,  // Pass userId through OAuth state parameter
    prompt: 'consent'
  });

  res.redirect(authUrl);
});

app.get('/oauth/callback', async (req, res) => {
  const code = req.query.code as string;
  const userId = req.query.state as string;

  if (!userId) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Invalid State</title>
          <style>
            body { font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px; }
            h1 { color: #dc2626; }
          </style>
        </head>
        <body>
          <h1>❌ Invalid authentication state</h1>
          <p>The userId was not preserved during the OAuth flow. Please try again.</p>
        </body>
      </html>
    `);
  }

  try {
    console.log(`✅ OAuth callback received for user: ${userId}`);

    const { tokens } = await oauth2Client.getToken(code);
    await saveTokens(userId, tokens);

    console.log(`💾 Tokens saved for user: ${userId}`);

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authentication Successful</title>
          <style>
            body {
              font-family: system-ui;
              max-width: 600px;
              margin: 50px auto;
              padding: 20px;
              text-align: center;
            }
            h1 { color: #10b981; }
            .user-id {
              background: #f3f4f6;
              padding: 10px;
              border-radius: 8px;
              margin: 20px 0;
              font-family: monospace;
            }
          </style>
          <script>
            // Notify parent window of success
            if (window.opener) {
              window.opener.postMessage(
                { type: 'oauth-success', userId: '${userId}' },
                '${process.env.FRONTEND_URL || 'https://naurra.ai'}'
              );
            }
            // Auto-close after 2 seconds
            setTimeout(() => window.close(), 2000);
          </script>
        </head>
        <body>
          <h1>✅ Authentication Successful!</h1>
          <p>Your Google Workspace account has been connected.</p>
          <div class="user-id">User ID: ${userId}</div>
          <p>This window will close automatically...</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authentication Failed</title>
          <style>
            body { font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
            h1 { color: #dc2626; }
            pre { background: #f3f4f6; padding: 10px; border-radius: 4px; overflow-x: auto; text-align: left; }
          </style>
          <script>
            // Notify parent window of failure
            if (window.opener) {
              window.opener.postMessage(
                { type: 'oauth-error', error: '${String(error).replace(/'/g, "\\'")}' },
                '${process.env.FRONTEND_URL || 'https://naurra.ai'}'
              );
            }
            // Auto-close after 3 seconds
            setTimeout(() => window.close(), 3000);
          </script>
        </head>
        <body>
          <h1>❌ Authentication Failed</h1>
          <p>An error occurred while saving your credentials.</p>
          <pre>${error}</pre>
          <p>This window will close automatically...</p>
        </body>
      </html>
    `);
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

// ========================================
// MCP SERVER SETUP
// ========================================

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
            body: { type: 'string', description: 'Email body (plain text or HTML)' },
            isHtml: { type: 'boolean', description: 'Set to true if body contains HTML content (default: auto-detect)', default: false },
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
        name: 'sheets_create',
        description: 'Create a new Google Spreadsheet with optional sheet tabs and data. Returns spreadsheet ID and URL.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Spreadsheet title' },
            sheetNames: {
              type: 'array',
              description: 'Names of sheets/tabs to create (e.g., ["Executive Summary", "Revenue", "Expenses"]). Defaults to one "Sheet1" tab.',
              items: { type: 'string' }
            },
            data: {
              type: 'object',
              description: 'Optional data to populate sheets. Keys are sheet names, values are 2D arrays of rows. Example: {"Revenue": [["Month","Amount"],["Jan","$100K"]]}',
              additionalProperties: {
                type: 'array',
                items: {
                  type: 'array',
                  items: { type: 'string' }
                }
              }
            },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['title']
        }
      },
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
        description: 'Write data to a Google Sheet. Supports formulas (e.g., =SUM(A1:A5)) and auto-formats numbers/dates.',
        inputSchema: {
          type: 'object',
          properties: {
            spreadsheetId: { type: 'string', description: 'Google Sheets spreadsheet ID' },
            range: { type: 'string', description: 'Range to write (e.g., "Sheet1!A1" or "Revenue!A1:D10")' },
            values: {
              type: 'array',
              description: 'Array of rows to write (e.g., [["Name", "Amount"], ["Revenue", "=SUM(B2:B5)"]])',
              items: {
                type: 'array',
                items: {
                  type: 'string'
                }
              }
            },
            raw: { type: 'boolean', description: 'If true, writes raw text without parsing formulas. Default false (formulas like =SUM are evaluated).', default: false },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['spreadsheetId', 'range', 'values']
        }
      },
      {
        name: 'sheets_add_sheet',
        description: 'Add a new sheet tab to an existing Google Spreadsheet',
        inputSchema: {
          type: 'object',
          properties: {
            spreadsheetId: { type: 'string', description: 'Google Sheets spreadsheet ID' },
            sheetName: { type: 'string', description: 'Name for the new sheet tab' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['spreadsheetId', 'sheetName']
        }
      },
      // Google Sheets - Formatting Tools
      {
        name: 'sheets_format_cells',
        description: 'Format cells in a Google Sheet: bold, italic, font size/color, background color, number format (currency/percent/date), alignment, text wrapping. Apply multiple formats in one call.',
        inputSchema: {
          type: 'object',
          properties: {
            spreadsheetId: { type: 'string', description: 'Google Sheets spreadsheet ID' },
            range: { type: 'string', description: 'A1 notation range (e.g., "Sheet1!A1:D1" or "Revenue!B2:B20")' },
            bold: { type: 'boolean', description: 'Make text bold' },
            italic: { type: 'boolean', description: 'Make text italic' },
            fontSize: { type: 'number', description: 'Font size in points (e.g., 12)' },
            fontColor: { type: 'string', description: 'Font color as hex (#FF0000) or named color (red, blue, green, etc.)' },
            backgroundColor: { type: 'string', description: 'Cell background color as hex or named color' },
            numberFormat: { type: 'string', description: 'Number format type: "currency", "percent", "number", "date", "text"' },
            numberFormatPattern: { type: 'string', description: 'Custom number format pattern (e.g., "$#,##0.00", "0.00%"). Overrides numberFormat.' },
            horizontalAlignment: { type: 'string', description: 'Text alignment: "LEFT", "CENTER", "RIGHT"' },
            wrapStrategy: { type: 'string', description: 'Text wrapping: "WRAP", "CLIP", "OVERFLOW_CELL"' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['spreadsheetId', 'range']
        }
      },
      {
        name: 'sheets_freeze',
        description: 'Freeze rows and/or columns in a Google Sheet so they stay visible while scrolling.',
        inputSchema: {
          type: 'object',
          properties: {
            spreadsheetId: { type: 'string', description: 'Google Sheets spreadsheet ID' },
            sheetName: { type: 'string', description: 'Sheet tab name (defaults to first sheet)' },
            frozenRows: { type: 'number', description: 'Number of rows to freeze (e.g., 1 for header row)' },
            frozenColumns: { type: 'number', description: 'Number of columns to freeze' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['spreadsheetId']
        }
      },
      {
        name: 'sheets_merge_cells',
        description: 'Merge a range of cells in a Google Sheet.',
        inputSchema: {
          type: 'object',
          properties: {
            spreadsheetId: { type: 'string', description: 'Google Sheets spreadsheet ID' },
            range: { type: 'string', description: 'A1 notation range to merge (e.g., "Sheet1!A1:D1")' },
            mergeType: { type: 'string', description: 'Merge type: "MERGE_ALL" (default), "MERGE_COLUMNS", "MERGE_ROWS"' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['spreadsheetId', 'range']
        }
      },
      {
        name: 'sheets_set_column_width',
        description: 'Set the width of columns in a Google Sheet.',
        inputSchema: {
          type: 'object',
          properties: {
            spreadsheetId: { type: 'string', description: 'Google Sheets spreadsheet ID' },
            sheetName: { type: 'string', description: 'Sheet tab name (defaults to first sheet)' },
            startColumn: { type: 'string', description: 'Start column letter (e.g., "A")' },
            endColumn: { type: 'string', description: 'End column letter inclusive (e.g., "C")' },
            pixelSize: { type: 'number', description: 'Column width in pixels' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['spreadsheetId', 'startColumn', 'endColumn', 'pixelSize']
        }
      },
      {
        name: 'sheets_auto_resize',
        description: 'Auto-resize columns to fit their content in a Google Sheet.',
        inputSchema: {
          type: 'object',
          properties: {
            spreadsheetId: { type: 'string', description: 'Google Sheets spreadsheet ID' },
            sheetName: { type: 'string', description: 'Sheet tab name (defaults to first sheet)' },
            startColumn: { type: 'string', description: 'Start column letter (default: "A")' },
            endColumn: { type: 'string', description: 'End column letter (default: "Z")' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['spreadsheetId']
        }
      },
      {
        name: 'sheets_add_chart',
        description: 'Insert a chart into a Google Sheet. Supports BAR, LINE, COLUMN, AREA, SCATTER, and PIE chart types.',
        inputSchema: {
          type: 'object',
          properties: {
            spreadsheetId: { type: 'string', description: 'Google Sheets spreadsheet ID' },
            sheetName: { type: 'string', description: 'Sheet tab where data lives (defaults to first sheet)' },
            chartType: { type: 'string', description: 'Chart type: "BAR", "LINE", "COLUMN", "AREA", "SCATTER", or "PIE"' },
            dataRange: { type: 'string', description: 'A1 range of chart data (e.g., "A1:B10"). First column = labels, remaining = data series.' },
            title: { type: 'string', description: 'Chart title' },
            legendPosition: { type: 'string', description: 'Legend position: "BOTTOM_LEGEND", "LEFT_LEGEND", "RIGHT_LEGEND", "TOP_LEGEND", "NO_LEGEND". Default: "BOTTOM_LEGEND"' },
            headerCount: { type: 'number', description: 'Number of header rows in data range (default: 1)' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['spreadsheetId', 'chartType', 'dataRange']
        }
      },
      {
        name: 'sheets_conditional_format',
        description: 'Add conditional formatting rules to a Google Sheet. Color cells based on their value.',
        inputSchema: {
          type: 'object',
          properties: {
            spreadsheetId: { type: 'string', description: 'Google Sheets spreadsheet ID' },
            range: { type: 'string', description: 'A1 notation range to apply formatting (e.g., "Sheet1!B2:B20")' },
            ruleType: { type: 'string', description: 'Rule type: "GREATER_THAN", "LESS_THAN", "EQUAL_TO", "TEXT_CONTAINS", "NOT_EMPTY", "CUSTOM_FORMULA"' },
            values: { type: 'array', description: 'Condition values (e.g., ["100"] for GREATER_THAN, ["=A1>B1"] for CUSTOM_FORMULA). Not required for NOT_EMPTY.', items: { type: 'string' } },
            backgroundColor: { type: 'string', description: 'Background color for matching cells (hex or named). Default: green' },
            fontColor: { type: 'string', description: 'Text color for matching cells (hex or named)' },
            bold: { type: 'boolean', description: 'Bold text for matching cells' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['spreadsheetId', 'range', 'ruleType']
        }
      },
      {
        name: 'sheets_banding',
        description: 'Apply alternating row colors (banded rows) to a Google Sheet for better readability.',
        inputSchema: {
          type: 'object',
          properties: {
            spreadsheetId: { type: 'string', description: 'Google Sheets spreadsheet ID' },
            range: { type: 'string', description: 'A1 notation range for banding (e.g., "Sheet1!A1:F20")' },
            headerColor: { type: 'string', description: 'Header row color (hex or named). Default: "#4285F4" (blue)' },
            firstBandColor: { type: 'string', description: 'First alternating color. Default: "#FFFFFF" (white)' },
            secondBandColor: { type: 'string', description: 'Second alternating color. Default: "#E8F0FE" (light blue)' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['spreadsheetId', 'range']
        }
      },
      // Google Docs - Formatting Tools
      {
        name: 'docs_insert_table',
        description: 'Insert a table into a Google Doc, optionally pre-populated with data.',
        inputSchema: {
          type: 'object',
          properties: {
            documentId: { type: 'string', description: 'Document ID' },
            rows: { type: 'number', description: 'Number of rows' },
            columns: { type: 'number', description: 'Number of columns' },
            index: { type: 'number', description: 'Insert position (character index). Defaults to end of document.' },
            data: { type: 'array', description: 'Optional 2D array to populate the table (e.g., [["Name","Age"],["Alice","30"]])', items: { type: 'array', items: { type: 'string' } } },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['documentId', 'rows', 'columns']
        }
      },
      {
        name: 'docs_set_heading',
        description: 'Apply heading styles to paragraphs in a Google Doc.',
        inputSchema: {
          type: 'object',
          properties: {
            documentId: { type: 'string', description: 'Document ID' },
            startIndex: { type: 'number', description: 'Start index of the paragraph(s)' },
            endIndex: { type: 'number', description: 'End index of the paragraph(s)' },
            headingType: { type: 'string', description: 'Heading type: "TITLE", "SUBTITLE", "HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6", "NORMAL_TEXT"' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['documentId', 'startIndex', 'endIndex', 'headingType']
        }
      },
      {
        name: 'docs_insert_link',
        description: 'Add a hyperlink to a text range in a Google Doc.',
        inputSchema: {
          type: 'object',
          properties: {
            documentId: { type: 'string', description: 'Document ID' },
            startIndex: { type: 'number', description: 'Start index of the text to link' },
            endIndex: { type: 'number', description: 'End index of the text to link' },
            url: { type: 'string', description: 'The URL to link to' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['documentId', 'startIndex', 'endIndex', 'url']
        }
      },
      {
        name: 'docs_insert_list',
        description: 'Apply bullet or numbered list formatting to paragraphs in a Google Doc.',
        inputSchema: {
          type: 'object',
          properties: {
            documentId: { type: 'string', description: 'Document ID' },
            startIndex: { type: 'number', description: 'Start index of the range to format as list' },
            endIndex: { type: 'number', description: 'End index of the range' },
            listType: { type: 'string', description: 'List type: "BULLET" or "NUMBERED"' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['documentId', 'startIndex', 'endIndex', 'listType']
        }
      },
      // Google Drive - Folder Creation
      {
        name: 'drive_create_folder',
        description: 'Create a new folder in Google Drive. Optionally place it inside a parent folder.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Folder name' },
            parentFolderId: { type: 'string', description: 'Optional parent folder ID to nest inside' },
            userId: { type: 'string', description: 'User ID for OAuth', default: 'default-user' }
          },
          required: ['name']
        }
      }
    ]
  };
});

// ========================================
// HELPER FUNCTIONS
// ========================================

// Ensure text is always a valid string (prevents MCP -32602 errors)
function safeStringify(data: any): string {
  if (data === null || data === undefined) {
    return 'No data returned';
  }
  if (typeof data === 'string') {
    return data;
  }
  try {
    return JSON.stringify(data, null, 2);
  } catch (error) {
    return String(data);
  }
}

// Parse hex color string or named color to Google API RGB floats
function parseColor(color: string): { red: number; green: number; blue: number } {
  const named: Record<string, string> = {
    red: '#FF0000', green: '#00FF00', blue: '#0000FF',
    white: '#FFFFFF', black: '#000000', yellow: '#FFFF00',
    orange: '#FFA500', purple: '#800080', gray: '#808080',
    grey: '#808080', pink: '#FFC0CB', cyan: '#00FFFF',
    lightblue: '#ADD8E6', lightgreen: '#90EE90', lightgray: '#D3D3D3',
    darkblue: '#00008B', darkgreen: '#006400', darkred: '#8B0000',
  };
  const hex = named[color.toLowerCase()] || color;
  const match = hex.match(/^#?([0-9A-Fa-f]{6})$/);
  if (!match) return { red: 0, green: 0, blue: 0 };
  return {
    red: parseInt(match[1].substring(0, 2), 16) / 255,
    green: parseInt(match[1].substring(2, 4), 16) / 255,
    blue: parseInt(match[1].substring(4, 6), 16) / 255,
  };
}

// Convert column letter(s) to zero-based index: A=0, B=1, Z=25, AA=26
function columnLetterToIndex(letter: string): number {
  let index = 0;
  for (let i = 0; i < letter.length; i++) {
    index = index * 26 + (letter.charCodeAt(i) - 64);
  }
  return index - 1;
}

// Parse A1 range notation into GridRange object
function parseA1Range(range: string, sheetId: number): {
  sheetId: number; startRowIndex: number; endRowIndex: number;
  startColumnIndex: number; endColumnIndex: number;
} {
  // Strip sheet name prefix if present (e.g., "Sheet1!A1:D10" -> "A1:D10")
  const rangePart = range.includes('!') ? range.split('!')[1] : range;
  const parts = rangePart.split(':');
  const startMatch = parts[0].match(/^([A-Z]+)(\d+)$/);
  if (!startMatch) throw new Error(`Invalid range format: ${range}`);
  const startCol = columnLetterToIndex(startMatch[1]);
  const startRow = parseInt(startMatch[2]) - 1;

  if (parts.length === 1) {
    return { sheetId, startRowIndex: startRow, endRowIndex: startRow + 1, startColumnIndex: startCol, endColumnIndex: startCol + 1 };
  }

  const endMatch = parts[1].match(/^([A-Z]+)(\d+)$/);
  if (!endMatch) throw new Error(`Invalid range format: ${range}`);
  const endCol = columnLetterToIndex(endMatch[1]);
  const endRow = parseInt(endMatch[2]) - 1;
  return { sheetId, startRowIndex: startRow, endRowIndex: endRow + 1, startColumnIndex: startCol, endColumnIndex: endCol + 1 };
}

// Resolve sheet tab name to numeric sheetId
async function getSheetId(auth: any, spreadsheetId: string, sheetName?: string): Promise<number> {
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const allSheets = meta.data.sheets || [];
  if (!sheetName) return allSheets[0]?.properties?.sheetId || 0;
  const found = allSheets.find(s => s.properties?.title === sheetName);
  if (!found) throw new NotFoundError(`Sheet tab "${sheetName}" not found in spreadsheet.`);
  return found.properties!.sheetId!;
}

// Extract sheet name from A1 range (e.g., "'Revenue'!A1:D10" -> "Revenue")
function extractSheetName(range: string): string | undefined {
  if (!range.includes('!')) return undefined;
  return range.split('!')[0].replace(/^'|'$/g, '');
}

// ========================================
// TOOL HANDLERS
// ========================================

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
          content: [{ type: 'text', text: safeStringify(response.data) }]
        };
      }

      case 'gmail_send': {
        const gmail = google.gmail({ version: 'v1', auth });

        const body = (args as any).body;
        const subject = (args as any).subject;

        // Auto-detect HTML if not explicitly set
        const isHtml = (args as any).isHtml || /<[a-z][\s\S]*>/i.test(body);
        const contentType = isHtml ? 'text/html; charset=UTF-8' : 'text/plain; charset=UTF-8';

        // RFC 2047 encode subject for non-ASCII characters
        const encodedSubject = /[^\x20-\x7E]/.test(subject)
          ? `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`
          : subject;

        // Build email with proper MIME headers
        const email = [
          `To: ${(args as any).to}`,
          `Subject: ${encodedSubject}`,
          'MIME-Version: 1.0',
          `Content-Type: ${contentType}`,
          'Content-Transfer-Encoding: base64',
          '',
          Buffer.from(body, 'utf8').toString('base64')
        ].join('\n');

        // Encode to base64url format (RFC 4648)
        const encodedEmail = Buffer.from(email, 'utf8')
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');

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
          content: [{ type: 'text', text: safeStringify(response.data) }]
        };
      }

      // Google Drive handlers - USE SMART SEARCH
      case 'drive_search': {
        const files = await smartDriveSearch(auth, (args as any).query, (args as any).maxResults || 10);

        if (!files || files.length === 0) {
          return {
            content: [{
              type: 'text',
              text: 'No files found matching your search. The smart search tried multiple strategies including case-insensitive and partial matching.'
            }]
          };
        }

        return {
          content: [{ type: 'text', text: safeStringify(files) }]
        };
      }

      case 'drive_read': {
        const drive = google.drive({ version: 'v3', auth });

        try {
          const response = await drive.files.get({
            fileId: (args as any).fileId,
            alt: 'media'
          });
          return {
            content: [{ type: 'text', text: safeStringify(response.data) }]
          };
        } catch (error: any) {
          if (error.code === 404) {
            throw new NotFoundError(`File with ID "${(args as any).fileId}" not found. It may have been deleted or you don't have access.`);
          }
          throw error;
        }
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
          content: [{ type: 'text', text: safeStringify(response.data) }]
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
          content: [{ type: 'text', text: safeStringify(response.data.items) }]
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

        try {
          const response = await docs.documents.get({
            documentId: (args as any).documentId
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
          };
        } catch (error: any) {
          if (error.code === 404) {
            throw new NotFoundError(`Document with ID "${(args as any).documentId}" not found. It may have been deleted or you don't have access.`);
          }
          throw error;
        }
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

        try {
          const response = await sheets.spreadsheets.values.get({
            spreadsheetId: (args as any).spreadsheetId,
            range: (args as any).range || 'Sheet1'
          });
          return {
            content: [{ type: 'text', text: safeStringify(response.data.values || []) }]
          };
        } catch (error: any) {
          if (error.code === 404) {
            throw new NotFoundError(`Spreadsheet with ID "${(args as any).spreadsheetId}" not found. It may have been deleted or you don't have access.`);
          }
          throw error;
        }
      }

      case 'sheets_create': {
        const sheets = google.sheets({ version: 'v4', auth });
        const sheetNames: string[] = (args as any).sheetNames || ['Sheet1'];
        const data: Record<string, string[][]> = (args as any).data || {};

        // Build sheet properties for each tab
        const sheetsConfig = sheetNames.map((name: string, index: number) => ({
          properties: {
            title: name,
            index: index
          }
        }));

        // Create the spreadsheet with all tabs
        const createResponse = await sheets.spreadsheets.create({
          requestBody: {
            properties: { title: (args as any).title },
            sheets: sheetsConfig
          }
        });

        const spreadsheetId = createResponse.data.spreadsheetId!;
        const url = createResponse.data.spreadsheetUrl;

        // Populate data for each sheet that has data provided
        const writeResults: string[] = [];
        for (const [sheetName, rows] of Object.entries(data)) {
          if (rows && rows.length > 0) {
            try {
              const writeResponse = await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `'${sheetName}'!A1`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: rows }
              });
              writeResults.push(`${sheetName}: ${writeResponse.data.updatedCells} cells`);
            } catch (writeError: any) {
              writeResults.push(`${sheetName}: write failed - ${writeError.message}`);
            }
          }
        }

        const summary = [
          `Spreadsheet created: "${(args as any).title}"`,
          `ID: ${spreadsheetId}`,
          `URL: ${url}`,
          `Tabs: ${sheetNames.join(', ')}`,
          writeResults.length > 0 ? `Data written: ${writeResults.join('; ')}` : ''
        ].filter(Boolean).join('\n');

        return {
          content: [{ type: 'text', text: summary }]
        };
      }

      case 'sheets_write': {
        const sheets = google.sheets({ version: 'v4', auth });
        const valueInputOption = (args as any).raw ? 'RAW' : 'USER_ENTERED';
        const response = await sheets.spreadsheets.values.update({
          spreadsheetId: (args as any).spreadsheetId,
          range: (args as any).range,
          valueInputOption,
          requestBody: {
            values: (args as any).values
          }
        });
        return {
          content: [{ type: 'text', text: `Updated ${response.data.updatedCells} cells` }]
        };
      }

      case 'sheets_add_sheet': {
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.batchUpdate({
          spreadsheetId: (args as any).spreadsheetId,
          requestBody: {
            requests: [{
              addSheet: {
                properties: {
                  title: (args as any).sheetName
                }
              }
            }]
          }
        });
        const newSheet = response.data.replies?.[0]?.addSheet?.properties;
        return {
          content: [{ type: 'text', text: `Added sheet tab "${newSheet?.title}" (ID: ${newSheet?.sheetId})` }]
        };
      }

      // ========================================
      // SHEETS FORMATTING HANDLERS
      // ========================================

      case 'sheets_format_cells': {
        const sheets = google.sheets({ version: 'v4', auth });
        const rangeStr = (args as any).range;
        const sheetName = extractSheetName(rangeStr);
        const sheetId = await getSheetId(auth, (args as any).spreadsheetId, sheetName);
        const gridRange = parseA1Range(rangeStr, sheetId);

        const cellFormat: any = {};
        const fields: string[] = [];
        const textFormat: any = {};

        if ((args as any).bold !== undefined) { textFormat.bold = (args as any).bold; fields.push('userEnteredFormat.textFormat.bold'); }
        if ((args as any).italic !== undefined) { textFormat.italic = (args as any).italic; fields.push('userEnteredFormat.textFormat.italic'); }
        if ((args as any).fontSize) { textFormat.fontSize = { magnitude: (args as any).fontSize, unit: 'PT' }; fields.push('userEnteredFormat.textFormat.fontSize'); }
        if ((args as any).fontColor) { textFormat.foregroundColorStyle = { rgbColor: parseColor((args as any).fontColor) }; fields.push('userEnteredFormat.textFormat.foregroundColorStyle'); }
        if (Object.keys(textFormat).length > 0) cellFormat.textFormat = textFormat;

        if ((args as any).backgroundColor) { cellFormat.backgroundColor = parseColor((args as any).backgroundColor); fields.push('userEnteredFormat.backgroundColor'); }
        if ((args as any).horizontalAlignment) { cellFormat.horizontalAlignment = (args as any).horizontalAlignment; fields.push('userEnteredFormat.horizontalAlignment'); }
        if ((args as any).wrapStrategy) { cellFormat.wrapStrategy = (args as any).wrapStrategy; fields.push('userEnteredFormat.wrapStrategy'); }

        if ((args as any).numberFormatPattern) {
          cellFormat.numberFormat = { type: 'NUMBER', pattern: (args as any).numberFormatPattern };
          fields.push('userEnteredFormat.numberFormat');
        } else if ((args as any).numberFormat) {
          const formatMap: Record<string, { type: string; pattern: string }> = {
            currency: { type: 'CURRENCY', pattern: '$#,##0.00' },
            percent: { type: 'PERCENT', pattern: '0.00%' },
            number: { type: 'NUMBER', pattern: '#,##0.00' },
            date: { type: 'DATE', pattern: 'MMM dd, yyyy' },
            text: { type: 'TEXT', pattern: '' },
          };
          const fmt = formatMap[(args as any).numberFormat.toLowerCase()];
          if (fmt) { cellFormat.numberFormat = fmt; fields.push('userEnteredFormat.numberFormat'); }
        }

        try {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: (args as any).spreadsheetId,
            requestBody: {
              requests: [{
                repeatCell: {
                  range: gridRange,
                  cell: { userEnteredFormat: cellFormat },
                  fields: fields.join(',')
                }
              }]
            }
          });
          return { content: [{ type: 'text', text: `Formatted cells ${rangeStr}: ${fields.map(f => f.replace('userEnteredFormat.', '')).join(', ')}` }] };
        } catch (error: any) {
          if (error.code === 404) throw new NotFoundError(`Spreadsheet "${(args as any).spreadsheetId}" not found.`);
          throw error;
        }
      }

      case 'sheets_freeze': {
        const sheets = google.sheets({ version: 'v4', auth });
        const sheetId = await getSheetId(auth, (args as any).spreadsheetId, (args as any).sheetName);
        const gridProperties: any = {};
        const fieldParts: string[] = [];

        if ((args as any).frozenRows !== undefined) { gridProperties.frozenRowCount = (args as any).frozenRows; fieldParts.push('gridProperties.frozenRowCount'); }
        if ((args as any).frozenColumns !== undefined) { gridProperties.frozenColumnCount = (args as any).frozenColumns; fieldParts.push('gridProperties.frozenColumnCount'); }

        try {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: (args as any).spreadsheetId,
            requestBody: {
              requests: [{
                updateSheetProperties: {
                  properties: { sheetId, gridProperties },
                  fields: fieldParts.join(',')
                }
              }]
            }
          });
          return { content: [{ type: 'text', text: `Frozen ${(args as any).frozenRows || 0} row(s) and ${(args as any).frozenColumns || 0} column(s)` }] };
        } catch (error: any) {
          if (error.code === 404) throw new NotFoundError(`Spreadsheet "${(args as any).spreadsheetId}" not found.`);
          throw error;
        }
      }

      case 'sheets_merge_cells': {
        const sheets = google.sheets({ version: 'v4', auth });
        const rangeStr = (args as any).range;
        const sheetName = extractSheetName(rangeStr);
        const sheetId = await getSheetId(auth, (args as any).spreadsheetId, sheetName);
        const gridRange = parseA1Range(rangeStr, sheetId);

        try {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: (args as any).spreadsheetId,
            requestBody: {
              requests: [{
                mergeCells: {
                  range: gridRange,
                  mergeType: (args as any).mergeType || 'MERGE_ALL'
                }
              }]
            }
          });
          return { content: [{ type: 'text', text: `Merged cells ${rangeStr}` }] };
        } catch (error: any) {
          if (error.code === 404) throw new NotFoundError(`Spreadsheet "${(args as any).spreadsheetId}" not found.`);
          throw error;
        }
      }

      case 'sheets_set_column_width': {
        const sheets = google.sheets({ version: 'v4', auth });
        const sheetId = await getSheetId(auth, (args as any).spreadsheetId, (args as any).sheetName);
        const startCol = columnLetterToIndex((args as any).startColumn.toUpperCase());
        const endCol = columnLetterToIndex((args as any).endColumn.toUpperCase()) + 1;

        try {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: (args as any).spreadsheetId,
            requestBody: {
              requests: [{
                updateDimensionProperties: {
                  range: { sheetId, dimension: 'COLUMNS', startIndex: startCol, endIndex: endCol },
                  properties: { pixelSize: (args as any).pixelSize },
                  fields: 'pixelSize'
                }
              }]
            }
          });
          return { content: [{ type: 'text', text: `Set column width ${(args as any).startColumn}-${(args as any).endColumn} to ${(args as any).pixelSize}px` }] };
        } catch (error: any) {
          if (error.code === 404) throw new NotFoundError(`Spreadsheet "${(args as any).spreadsheetId}" not found.`);
          throw error;
        }
      }

      case 'sheets_auto_resize': {
        const sheets = google.sheets({ version: 'v4', auth });
        const sheetId = await getSheetId(auth, (args as any).spreadsheetId, (args as any).sheetName);
        const startCol = columnLetterToIndex(((args as any).startColumn || 'A').toUpperCase());
        const endCol = columnLetterToIndex(((args as any).endColumn || 'Z').toUpperCase()) + 1;

        try {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: (args as any).spreadsheetId,
            requestBody: {
              requests: [{
                autoResizeDimensions: {
                  dimensions: { sheetId, dimension: 'COLUMNS', startIndex: startCol, endIndex: endCol }
                }
              }]
            }
          });
          return { content: [{ type: 'text', text: `Auto-resized columns ${(args as any).startColumn || 'A'}-${(args as any).endColumn || 'Z'}` }] };
        } catch (error: any) {
          if (error.code === 404) throw new NotFoundError(`Spreadsheet "${(args as any).spreadsheetId}" not found.`);
          throw error;
        }
      }

      case 'sheets_add_chart': {
        const sheets = google.sheets({ version: 'v4', auth });
        const sheetName = (args as any).sheetName;
        const sheetId = await getSheetId(auth, (args as any).spreadsheetId, sheetName);
        const dataRange = parseA1Range((args as any).dataRange, sheetId);
        const chartType = ((args as any).chartType || 'BAR').toUpperCase();
        const headerCount = (args as any).headerCount || 1;
        const title = (args as any).title || '';
        const legendPosition = (args as any).legendPosition || 'BOTTOM_LEGEND';

        let chartSpec: any;

        if (chartType === 'PIE') {
          chartSpec = {
            title,
            pieChart: {
              legendPosition,
              domain: {
                sourceRange: { sources: [{ sheetId, startRowIndex: dataRange.startRowIndex, endRowIndex: dataRange.endRowIndex, startColumnIndex: dataRange.startColumnIndex, endColumnIndex: dataRange.startColumnIndex + 1 }] }
              },
              series: {
                sourceRange: { sources: [{ sheetId, startRowIndex: dataRange.startRowIndex, endRowIndex: dataRange.endRowIndex, startColumnIndex: dataRange.startColumnIndex + 1, endColumnIndex: dataRange.startColumnIndex + 2 }] }
              }
            }
          };
        } else {
          const domains = [{
            domain: {
              sourceRange: { sources: [{ sheetId, startRowIndex: dataRange.startRowIndex, endRowIndex: dataRange.endRowIndex, startColumnIndex: dataRange.startColumnIndex, endColumnIndex: dataRange.startColumnIndex + 1 }] }
            }
          }];
          const series = [];
          for (let col = dataRange.startColumnIndex + 1; col < dataRange.endColumnIndex; col++) {
            series.push({
              series: {
                sourceRange: { sources: [{ sheetId, startRowIndex: dataRange.startRowIndex, endRowIndex: dataRange.endRowIndex, startColumnIndex: col, endColumnIndex: col + 1 }] }
              },
              targetAxis: 'LEFT_AXIS'
            });
          }
          chartSpec = {
            title,
            basicChart: {
              chartType,
              legendPosition,
              domains,
              series,
              headerCount
            }
          };
        }

        try {
          const response = await sheets.spreadsheets.batchUpdate({
            spreadsheetId: (args as any).spreadsheetId,
            requestBody: {
              requests: [{
                addChart: {
                  chart: {
                    spec: chartSpec,
                    position: {
                      overlayPosition: {
                        anchorCell: { sheetId, rowIndex: dataRange.endRowIndex + 1, columnIndex: dataRange.startColumnIndex },
                        widthPixels: 600,
                        heightPixels: 400
                      }
                    }
                  }
                }
              }]
            }
          });
          const chartId = response.data.replies?.[0]?.addChart?.chart?.chartId;
          return { content: [{ type: 'text', text: `Added ${chartType} chart${title ? ` "${title}"` : ''} (ID: ${chartId})` }] };
        } catch (error: any) {
          if (error.code === 404) throw new NotFoundError(`Spreadsheet "${(args as any).spreadsheetId}" not found.`);
          throw error;
        }
      }

      case 'sheets_conditional_format': {
        const sheets = google.sheets({ version: 'v4', auth });
        const rangeStr = (args as any).range;
        const sheetName = extractSheetName(rangeStr);
        const sheetId = await getSheetId(auth, (args as any).spreadsheetId, sheetName);
        const gridRange = parseA1Range(rangeStr, sheetId);

        const ruleTypeMap: Record<string, string> = {
          'GREATER_THAN': 'NUMBER_GREATER',
          'LESS_THAN': 'NUMBER_LESS',
          'EQUAL_TO': 'NUMBER_EQ',
          'TEXT_CONTAINS': 'TEXT_CONTAINS',
          'NOT_EMPTY': 'NOT_BLANK',
          'CUSTOM_FORMULA': 'CUSTOM_FORMULA',
        };
        const conditionType = ruleTypeMap[((args as any).ruleType || '').toUpperCase()] || (args as any).ruleType;
        const conditionValues = ((args as any).values || []).map((v: string) => ({ userEnteredValue: v }));

        const format: any = {};
        if ((args as any).backgroundColor) { format.backgroundColor = parseColor((args as any).backgroundColor); }
        else { format.backgroundColor = parseColor('#00FF00'); }
        if ((args as any).fontColor) { format.textFormat = { ...format.textFormat, foregroundColor: parseColor((args as any).fontColor) }; }
        if ((args as any).bold) { format.textFormat = { ...format.textFormat, bold: true }; }

        try {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: (args as any).spreadsheetId,
            requestBody: {
              requests: [{
                addConditionalFormatRule: {
                  rule: {
                    ranges: [gridRange],
                    booleanRule: {
                      condition: { type: conditionType, values: conditionValues.length > 0 ? conditionValues : undefined },
                      format
                    }
                  },
                  index: 0
                }
              }]
            }
          });
          return { content: [{ type: 'text', text: `Added conditional format rule (${(args as any).ruleType}) to ${rangeStr}` }] };
        } catch (error: any) {
          if (error.code === 404) throw new NotFoundError(`Spreadsheet "${(args as any).spreadsheetId}" not found.`);
          throw error;
        }
      }

      case 'sheets_banding': {
        const sheets = google.sheets({ version: 'v4', auth });
        const rangeStr = (args as any).range;
        const sheetName = extractSheetName(rangeStr);
        const sheetId = await getSheetId(auth, (args as any).spreadsheetId, sheetName);
        const gridRange = parseA1Range(rangeStr, sheetId);

        const headerColor = parseColor((args as any).headerColor || '#4285F4');
        const firstBandColor = parseColor((args as any).firstBandColor || '#FFFFFF');
        const secondBandColor = parseColor((args as any).secondBandColor || '#E8F0FE');

        try {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: (args as any).spreadsheetId,
            requestBody: {
              requests: [{
                addBanding: {
                  bandedRange: {
                    range: gridRange,
                    rowProperties: {
                      headerColor,
                      firstBandColor,
                      secondBandColor
                    }
                  }
                }
              }]
            }
          });
          return { content: [{ type: 'text', text: `Applied alternating row colors to ${rangeStr}` }] };
        } catch (error: any) {
          if (error.code === 404) throw new NotFoundError(`Spreadsheet "${(args as any).spreadsheetId}" not found.`);
          throw error;
        }
      }

      // ========================================
      // DOCS FORMATTING HANDLERS
      // ========================================

      case 'docs_insert_table': {
        const docs = google.docs({ version: 'v1', auth });

        try {
          let insertIndex = (args as any).index;
          if (insertIndex === undefined) {
            const doc = await docs.documents.get({ documentId: (args as any).documentId });
            insertIndex = (doc.data.body?.content?.slice(-1)[0]?.endIndex || 2) - 1;
          }

          // Insert the table
          await docs.documents.batchUpdate({
            documentId: (args as any).documentId,
            requestBody: {
              requests: [{
                insertTable: {
                  rows: (args as any).rows,
                  columns: (args as any).columns,
                  location: { index: insertIndex }
                }
              }]
            }
          });

          // If data is provided, populate the table cells
          if ((args as any).data && (args as any).data.length > 0) {
            // Re-read the document to get table cell indices
            const updatedDoc = await docs.documents.get({ documentId: (args as any).documentId });
            const body = updatedDoc.data.body?.content || [];

            // Find the table we just inserted
            const table = body.find((el: any) => el.table && el.startIndex >= insertIndex);
            if (table && table.table) {
              const insertRequests: any[] = [];
              const tableRows = table.table.tableRows || [];

              for (let r = 0; r < Math.min((args as any).data.length, tableRows.length); r++) {
                const cells = tableRows[r].tableCells || [];
                for (let c = 0; c < Math.min((args as any).data[r].length, cells.length); c++) {
                  const cellContent = cells[c].content;
                  if (cellContent && cellContent[0]) {
                    const cellIndex = cellContent[0].startIndex;
                    const text = (args as any).data[r][c];
                    if (text) {
                      insertRequests.push({
                        insertText: {
                          location: { index: cellIndex },
                          text
                        }
                      });
                    }
                  }
                }
              }

              // Execute in reverse order to preserve indices
              if (insertRequests.length > 0) {
                insertRequests.reverse();
                await docs.documents.batchUpdate({
                  documentId: (args as any).documentId,
                  requestBody: { requests: insertRequests }
                });
              }
            }
          }

          return { content: [{ type: 'text', text: `Inserted ${(args as any).rows}x${(args as any).columns} table${(args as any).data ? ' with data' : ''}` }] };
        } catch (error: any) {
          if (error.code === 404) throw new NotFoundError(`Document "${(args as any).documentId}" not found.`);
          throw error;
        }
      }

      case 'docs_set_heading': {
        const docs = google.docs({ version: 'v1', auth });

        try {
          await docs.documents.batchUpdate({
            documentId: (args as any).documentId,
            requestBody: {
              requests: [{
                updateParagraphStyle: {
                  range: {
                    startIndex: (args as any).startIndex,
                    endIndex: (args as any).endIndex
                  },
                  paragraphStyle: {
                    namedStyleType: (args as any).headingType
                  },
                  fields: 'namedStyleType'
                }
              }]
            }
          });
          return { content: [{ type: 'text', text: `Applied ${(args as any).headingType} style` }] };
        } catch (error: any) {
          if (error.code === 404) throw new NotFoundError(`Document "${(args as any).documentId}" not found.`);
          throw error;
        }
      }

      case 'docs_insert_link': {
        const docs = google.docs({ version: 'v1', auth });

        try {
          await docs.documents.batchUpdate({
            documentId: (args as any).documentId,
            requestBody: {
              requests: [{
                updateTextStyle: {
                  range: {
                    startIndex: (args as any).startIndex,
                    endIndex: (args as any).endIndex
                  },
                  textStyle: {
                    link: { url: (args as any).url }
                  },
                  fields: 'link'
                }
              }]
            }
          });
          return { content: [{ type: 'text', text: `Added link to "${(args as any).url}"` }] };
        } catch (error: any) {
          if (error.code === 404) throw new NotFoundError(`Document "${(args as any).documentId}" not found.`);
          throw error;
        }
      }

      case 'docs_insert_list': {
        const docs = google.docs({ version: 'v1', auth });
        const presetMap: Record<string, string> = {
          'BULLET': 'BULLET_DISC_CIRCLE_SQUARE',
          'NUMBERED': 'NUMBERED_DECIMAL_ALPHA_ROMAN',
        };
        const bulletPreset = presetMap[((args as any).listType || 'BULLET').toUpperCase()] || 'BULLET_DISC_CIRCLE_SQUARE';

        try {
          await docs.documents.batchUpdate({
            documentId: (args as any).documentId,
            requestBody: {
              requests: [{
                createParagraphBullets: {
                  range: {
                    startIndex: (args as any).startIndex,
                    endIndex: (args as any).endIndex
                  },
                  bulletPreset
                }
              }]
            }
          });
          return { content: [{ type: 'text', text: `Applied ${(args as any).listType} list formatting` }] };
        } catch (error: any) {
          if (error.code === 404) throw new NotFoundError(`Document "${(args as any).documentId}" not found.`);
          throw error;
        }
      }

      case 'drive_create_folder': {
        const drive = google.drive({ version: 'v3', auth });
        const requestBody: any = {
          name: (args as any).name,
          mimeType: 'application/vnd.google-apps.folder'
        };
        if ((args as any).parentFolderId) {
          requestBody.parents = [(args as any).parentFolderId];
        }
        const response = await drive.files.create({
          requestBody,
          fields: 'id, name, webViewLink'
        });
        return {
          content: [{ type: 'text', text: safeStringify(response.data) }]
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

        try {
          const response = await calendar.events.patch({
            calendarId: 'primary',
            eventId: (args as any).eventId,
            requestBody: updateBody
          });
          return {
            content: [{ type: 'text', text: `Event updated successfully! Link: ${response.data.htmlLink}` }]
          };
        } catch (error: any) {
          if (error.code === 404) {
            throw new NotFoundError(`Calendar event with ID "${(args as any).eventId}" not found.`);
          }
          throw error;
        }
      }

      case 'calendar_delete_event': {
        const calendar = google.calendar({ version: 'v3', auth });

        try {
          await calendar.events.delete({
            calendarId: 'primary',
            eventId: (args as any).eventId
          });
          return {
            content: [{ type: 'text', text: 'Event deleted successfully!' }]
          };
        } catch (error: any) {
          if (error.code === 404) {
            throw new NotFoundError(`Calendar event with ID "${(args as any).eventId}" not found.`);
          }
          throw error;
        }
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
          content: [{ type: 'text', text: safeStringify(response.data.results) }]
        };
      }

      case 'contacts_update': {
        const people = google.people({ version: 'v1', auth });

        try {
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
        } catch (error: any) {
          if (error.code === 404) {
            throw new NotFoundError(`Contact with resource name "${(args as any).resourceName}" not found.`);
          }
          throw error;
        }
      }

      case 'contacts_delete': {
        const people = google.people({ version: 'v1', auth });

        try {
          await people.people.deleteContact({
            resourceName: (args as any).resourceName
          });
          return {
            content: [{ type: 'text', text: 'Contact deleted successfully!' }]
          };
        } catch (error: any) {
          if (error.code === 404) {
            throw new NotFoundError(`Contact with resource name "${(args as any).resourceName}" not found.`);
          }
          throw error;
        }
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
          content: [{ type: 'text', text: safeStringify(response.data.items) }]
        };
      }

      case 'tasks_update': {
        const tasks = google.tasks({ version: 'v1', auth });
        const updateBody: any = {};
        if ((args as any).title) updateBody.title = (args as any).title;
        if ((args as any).notes) updateBody.notes = (args as any).notes;
        if ((args as any).due) updateBody.due = (args as any).due;

        try {
          const response = await tasks.tasks.patch({
            tasklist: (args as any).taskListId || '@default',
            task: (args as any).taskId,
            requestBody: updateBody
          });
          return {
            content: [{ type: 'text', text: 'Task updated successfully!' }]
          };
        } catch (error: any) {
          if (error.code === 404) {
            throw new NotFoundError(`Task with ID "${(args as any).taskId}" not found.`);
          }
          throw error;
        }
      }

      case 'tasks_complete': {
        const tasks = google.tasks({ version: 'v1', auth });

        try {
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
        } catch (error: any) {
          if (error.code === 404) {
            throw new NotFoundError(`Task with ID "${(args as any).taskId}" not found.`);
          }
          throw error;
        }
      }

      case 'tasks_delete': {
        const tasks = google.tasks({ version: 'v1', auth });

        try {
          await tasks.tasks.delete({
            tasklist: (args as any).taskListId || '@default',
            task: (args as any).taskId
          });
          return {
            content: [{ type: 'text', text: 'Task deleted successfully!' }]
          };
        } catch (error: any) {
          if (error.code === 404) {
            throw new NotFoundError(`Task with ID "${(args as any).taskId}" not found.`);
          }
          throw error;
        }
      }

      // Drive Extended handlers
      case 'drive_delete': {
        const drive = google.drive({ version: 'v3', auth });

        try {
          await drive.files.delete({
            fileId: (args as any).fileId
          });
          return {
            content: [{ type: 'text', text: 'File deleted successfully!' }]
          };
        } catch (error: any) {
          if (error.code === 404) {
            throw new NotFoundError(`File with ID "${(args as any).fileId}" not found.`);
          }
          throw error;
        }
      }

      case 'drive_rename': {
        const drive = google.drive({ version: 'v3', auth });

        try {
          const response = await drive.files.update({
            fileId: (args as any).fileId,
            requestBody: {
              name: (args as any).newName
            }
          });
          return {
            content: [{ type: 'text', text: `File renamed to: ${response.data.name}` }]
          };
        } catch (error: any) {
          if (error.code === 404) {
            throw new NotFoundError(`File with ID "${(args as any).fileId}" not found.`);
          }
          throw error;
        }
      }

      case 'drive_change_permissions': {
        const drive = google.drive({ version: 'v3', auth });

        try {
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
        } catch (error: any) {
          if (error.code === 404) {
            throw new NotFoundError(`File with ID "${(args as any).fileId}" not found.`);
          }
          if (error.code === 403) {
            throw new PermissionError(`You don't have permission to share this file.`);
          }
          throw error;
        }
      }

      // Docs Extended handlers
      case 'docs_delete': {
        const drive = google.drive({ version: 'v3', auth });

        try {
          await drive.files.delete({
            fileId: (args as any).documentId
          });
          return {
            content: [{ type: 'text', text: 'Document deleted successfully!' }]
          };
        } catch (error: any) {
          if (error.code === 404) {
            throw new NotFoundError(`Document with ID "${(args as any).documentId}" not found.`);
          }
          throw error;
        }
      }

      case 'docs_append': {
        const docs = google.docs({ version: 'v1', auth });

        try {
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
        } catch (error: any) {
          if (error.code === 404) {
            throw new NotFoundError(`Document with ID "${(args as any).documentId}" not found.`);
          }
          throw error;
        }
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

        try {
          await docs.documents.batchUpdate({
            documentId: (args as any).documentId,
            requestBody: { requests }
          });
          return {
            content: [{ type: 'text', text: 'Text formatted successfully!' }]
          };
        } catch (error: any) {
          if (error.code === 404) {
            throw new NotFoundError(`Document with ID "${(args as any).documentId}" not found.`);
          }
          throw error;
        }
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

        try {
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
        } catch (error: any) {
          if (error.code === 404) {
            throw new NotFoundError(`Calendar event with ID "${(args as any).eventId}" not found.`);
          }
          throw error;
        }
      }

      case 'meet_cancel': {
        const calendar = google.calendar({ version: 'v3', auth });

        try {
          await calendar.events.delete({
            calendarId: 'primary',
            eventId: (args as any).eventId,
            sendUpdates: 'all'
          });
          return {
            content: [{ type: 'text', text: 'Google Meet meeting cancelled and attendees notified!' }]
          };
        } catch (error: any) {
          if (error.code === 404) {
            throw new NotFoundError(`Calendar event with ID "${(args as any).eventId}" not found.`);
          }
          throw error;
        }
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

        const meetingsWithLinks = response.data.items?.filter(event => event.hangoutLink) || [];
        return {
          content: [{
            type: 'text',
            text: safeStringify(meetingsWithLinks)
          }]
        };
      }

      case 'meet_add_participants': {
        const calendar = google.calendar({ version: 'v3', auth });

        try {
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
        } catch (error: any) {
          if (error.code === 404) {
            throw new NotFoundError(`Calendar event with ID "${(args as any).eventId}" not found.`);
          }
          throw error;
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

  } catch (error: any) {
    console.error(`❌ Error executing tool "${name}":`, error);

    // ========================================
    // ENHANCED ERROR CLASSIFICATION
    // ========================================

    // Authentication errors
    if (error instanceof AuthenticationError ||
        error.message?.includes('invalid_grant') ||
        error.message?.includes('Invalid Credentials')) {
      return {
        content: [{
          type: 'text',
          text: `🔒 Authentication Required

${error.message}

Please authenticate by visiting the OAuth URL above.`
        }],
        isError: true
      };
    }

    // Not found errors
    if (error instanceof NotFoundError ||
        error.code === 404 ||
        error.message?.includes('not found')) {
      return {
        content: [{
          type: 'text',
          text: `❌ Not Found

${error.message}

The requested resource doesn't exist, may have been deleted, or you don't have access to it.`
        }],
        isError: true
      };
    }

    // Permission errors
    if (error instanceof PermissionError ||
        error.code === 403 ||
        error.message?.includes('permission') ||
        error.message?.includes('forbidden')) {
      return {
        content: [{
          type: 'text',
          text: `🚫 Permission Denied

${error.message}

You don't have the necessary permissions to access or modify this resource.`
        }],
        isError: true
      };
    }

    // Temporary/network errors
    if (error instanceof TemporaryError ||
        error.message?.includes('ECONNREFUSED') ||
        error.message?.includes('timeout') ||
        error.message?.includes('ETIMEDOUT') ||
        error.message?.includes('temporarily unavailable')) {
      return {
        content: [{
          type: 'text',
          text: `⏱️ Temporary Error

${error.message}

This is likely a temporary network issue. Please try again in a moment.`
        }],
        isError: true
      };
    }

    // Rate limit errors
    if (error.code === 429 || error.message?.includes('rate limit')) {
      return {
        content: [{
          type: 'text',
          text: `⚠️ Rate Limit Exceeded

You've made too many requests in a short period. Please wait a moment before trying again.`
        }],
        isError: true
      };
    }

    // Unknown errors - provide helpful context
    return {
      content: [{
        type: 'text',
        text: `❌ Error: ${error.message}

If this error persists, please check:
- Your internet connection
- The parameters you provided
- Whether you have access to the requested resource`
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
  console.log(`✨ Enhanced with smart search and robust error handling`);
});
