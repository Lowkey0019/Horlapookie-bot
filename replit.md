# Eclipse MD WhatsApp Bot

## Overview
A feature-rich WhatsApp bot built with Node.js using Baileys library. Supports 648+ commands including AI chat, group management, media processing, and more.

## Recent Changes (Dec 31, 2025)

### Fixed Issues:
1. **Menu Command "next" Response** - Now displays properly formatted support links:
   - GitHub, Support, Deploy, Bug Report, Telegram Channel, Direct Telegram

2. **Antilink Detection** - Fixed regex pattern testing issue that was preventing link detection:
   - Resolved global flag issue with regex patterns
   - Added proper iteration through link patterns
   - Now properly detects and handles links in groups

3. **Antilink Handler Integration** - Added missing antilink detection in message handler:
   - Antilink now actively monitors group messages
   - Works alongside antitag (which was already working)

4. **Session ID Error Messages** - Improved user-facing error messages:
   - Clear instructions when session setup fails
   - Shows 3 options for providing authentication data

5. **Memory Leak Prevention** - Added automatic cleanup:
   - Clears old message counts every 10 minutes
   - Clears expired antilink warnings
   - Prevents memory overflow on Heroku deployments (exit 137 issue)

## Project Structure
```
.
├── index.js              # Main bot entry point
├── config.js             # Configuration settings
├── eclipse-plug/         # Commands (648+ files)
├── eclipse-plug/self/    # Self-bot commands
├── lib/                  # Utility libraries
├── data/                 # Persistent storage
└── auth_info/            # WhatsApp authentication
```

## Key Features
- 648+ Commands
- AI Chat Models (GPT-4, Claude, Gemini, etc.)
- Group Management
- Media Processing
- Newsletter Integration
- Antilink & Antitag
- Antibug & Anticall Systems
- Memory optimization for long-running deployments

## Environment Variables
- `BOT_SESSION_DATA` - Base64 encoded session data
- `BOT_SESSION_FILE` - Path to SESSION-ID file
- `BOT_PREFIX` - Command prefix (default: .)
- `AUTO_VIEW_MESSAGE` - Auto view messages
- `AUTO_VIEW_STATUS` - Auto view status
- `AUTO_REACT_STATUS` - Auto react to status
- `AUTO_STATUS_EMOJI` - Status reaction emoji

## Running the Bot
```bash
npm install
node index.js
```

The bot will display a QR code for WhatsApp authentication on first run.

## Bot Commands
- `.menu` - Display all available commands
- `.antilink` - Manage antilink settings
- `.antitag` - Manage antitag settings
- `.alive` - Check bot status
- `.ping` - Ping the bot

## Known Issues Fixed
- ✅ Heroku exit 137 (memory management)
- ✅ Antilink not working
- ✅ Menu "next" command not showing links
- ✅ Session ID asking message improved

## Deployment
- Supports Heroku, Render, Replit
- Uses nix environment (no Docker)
- Automatic temp directory cleanup
- Memory-efficient long-running operation
