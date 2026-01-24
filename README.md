# Google Workspace MCP Server for n8n

Complete Google Workspace integration for your n8n AI agent via MCP (Model Context Protocol).

## 🎯 What This Does

Gives your n8n AI agent access to:
- ✉️ **Gmail** - Search, read, send emails
- 📁 **Google Drive** - Search, read, create files
- 📅 **Google Calendar** - List, create events
- 📝 **Google Docs** - Read, create documents
- 📊 **Google Sheets** - Read, write spreadsheet data

## 🚀 Quick Setup

### Step 1: Install Dependencies

```bash
npm install
```

### Step 2: Get Google OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select existing)
3. Enable these APIs:
   - Gmail API
   - Google Drive API
   - Google Calendar API
   - Google Docs API
   - Google Sheets API

4. Create OAuth credentials:
   - Go to **APIs & Services** → **Credentials**
   - Click **Create Credentials** → **OAuth client ID**
   - Application type: **Web application**
   - Add authorized redirect URIs:
     - For local testing: `http://localhost:3000/oauth/callback`
     - For Railway: `https://your-app.railway.app/oauth/callback`
   - Copy **Client ID** and **Client Secret**

### Step 3: Configure Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` and add your credentials:

```env
PORT=3000
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/callback
SESSION_SECRET=any-random-string-here
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-service-role-key
```

### Step 3.5: Setup Supabase Database

1. Create a free account at [Supabase](https://supabase.com)
2. Create a new project
3. Go to **SQL Editor** and run this:

```sql
-- Create oauth_tokens table
CREATE TABLE oauth_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  tokens JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index on user_id for faster lookups
CREATE INDEX idx_oauth_tokens_user_id ON oauth_tokens(user_id);

-- Create function to auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-update updated_at
CREATE TRIGGER update_oauth_tokens_updated_at
  BEFORE UPDATE ON oauth_tokens
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
```

4. Get your credentials:
   - Go to **Project Settings** → **API**
   - Copy **Project URL** → Use as `SUPABASE_URL`
   - Copy **service_role key** → Use as `SUPABASE_KEY`

5. Add these to your `.env` file

### Step 4: Run the Server

**Local development:**
```bash
npm run dev
```

**Production:**
```bash
npm run build
npm start
```

Server will run on `http://localhost:3000`

### Step 5: Authenticate with Google

1. Visit: `http://localhost:3000/oauth/start`
2. Sign in with your Google account
3. Grant all permissions
4. You'll see "Authentication successful!"

### Step 6: Configure n8n

In your n8n AI Agent workflow:

1. Add **MCP Tool** node
2. Configure:
   - **Transport Type**: `HTTP Streamable`
   - **Endpoint URL**: `http://localhost:3000/mcp`
   - (If deployed to Railway: `https://your-app.railway.app/mcp`)

3. Connect to your AI Agent node

Done! Your AI agent now has full Google Workspace access.

## 📡 Deploy to Railway

### Option 1: Deploy from GitHub

1. Push this code to a GitHub repo
2. Go to [Railway](https://railway.app)
3. Click **New Project** → **Deploy from GitHub repo**
4. Select your repository
5. Add environment variables in Railway dashboard:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI` (use your Railway URL)
   - `SESSION_SECRET`
6. Deploy!

### Option 2: Deploy with Railway CLI

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

Add environment variables:
```bash
railway variables set GOOGLE_CLIENT_ID=your-id
railway variables set GOOGLE_CLIENT_SECRET=your-secret
railway variables set GOOGLE_REDIRECT_URI=https://your-app.railway.app/oauth/callback
railway variables set SESSION_SECRET=random-string
```

**Important:** After deploying, update your Google OAuth redirect URI in Google Cloud Console to match your Railway URL!

## 🛠️ Available Tools

Your AI agent can now use these tools:

### Gmail
- `gmail_search` - Search emails by query
- `gmail_send` - Send emails
- `gmail_read` - Read specific email by ID

### Google Drive
- `drive_search` - Search files/folders
- `drive_read` - Read file content
- `drive_create` - Create new files

### Google Calendar
- `calendar_list_events` - List upcoming events
- `calendar_create_event` - Create new events

### Google Docs
- `docs_read` - Read document content
- `docs_create` - Create new documents

### Google Sheets
- `sheets_read` - Read spreadsheet data
- `sheets_write` - Write data to sheets

## 💬 Example Usage in n8n

Once configured, you can ask your AI agent:

- "Search my Gmail for emails from john@example.com about the project"
- "Send an email to team@company.com with subject 'Meeting Notes'"
- "Find all PDF files in my Google Drive"
- "Create a new Google Doc titled 'Meeting Notes' with content..."
- "What events do I have on my calendar tomorrow?"
- "Read the data from my budget spreadsheet"

## 🔒 Security Notes

- OAuth tokens are stored in memory (not persistent)
- For production, replace `userTokens` Map with a database
- Each user authenticates individually
- Never commit `.env` file to git

## 🐛 Troubleshooting

**"User not authenticated" error:**
- Visit `http://your-server/oauth/start` to authenticate

**"Invalid redirect URI" error:**
- Make sure redirect URI in `.env` matches Google Cloud Console settings

**API not enabled:**
- Enable required APIs in Google Cloud Console

**Railway deployment issues:**
- Check environment variables are set correctly
- Verify redirect URI uses Railway URL, not localhost

## 📝 Multi-User Support

The server supports multiple users with individual OAuth:

- Each user gets a unique `userId`
- Visit: `http://your-server/oauth/start?userId=john`
- When calling tools from n8n, include `userId` parameter

## 🎉 You're All Set!

Your n8n AI agent now has complete Google Workspace access. Test it by asking it to interact with your Gmail, Drive, Calendar, Docs, or Sheets!
