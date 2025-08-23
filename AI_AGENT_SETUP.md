# AI Agent Setup Guide

## Overview

The AI Agent API allows users to query your MongoDB database using natural language. It leverages Google's Gemini AI to convert natural language queries into optimized MongoDB queries and returns results in the same format as your existing API endpoints.

## Features

- **Natural Language Processing**: Convert plain English queries into MongoDB operations
- **Security**: Automatically excludes sensitive fields like passwords from results
- **Optimized Queries**: AI generates efficient MongoDB queries with proper indexing considerations
- **Same Response Format**: Returns data in the same structure as existing API endpoints
- **Multiple Operations**: Supports find, findOne, count, and aggregate operations

## Setup Instructions

### 1. Install Dependencies

The required packages have been installed:
```bash
npm install @langchain/google-genai @langchain/core langchain
```

### 2. Environment Configuration

Add your Google API key to your environment file (`.env.development.local`):

```env
# Google API Configuration (Required for AI Agent)
GOOGLE_API_KEY=your-google-gemini-api-key-here
```

**To get a Google API key:**
1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Click "Create API Key"
3. Copy the generated key
4. Add it to your environment file

### 3. API Endpoints

The AI Agent provides three main endpoints:

#### Get Status
```http
GET /api/ai-agent/status
```
Returns the current status of the AI agent.

#### Get Sample Queries
```http
GET /api/ai-agent/samples
```
Returns a list of example queries you can try.

#### Process Query
```http
POST /api/ai-agent/query
Content-Type: application/json

{
  "query": "Get all users with Gmail email addresses"
}
```

## Example Queries

Here are some example natural language queries you can use:

1. **Basic Queries:**
   - "Get all users"
   - "Count total number of users"
   - "Find user with email john@example.com"

2. **Date-based Queries:**
   - "Get users created in the last 7 days"
   - "Show me users created in the last month"
   - "Find users created today"

3. **Pattern-based Queries:**
   - "Find all users with Gmail email addresses"
   - "Get users with hotmail emails"
   - "Show me users with .edu email domains"

4. **Sorting and Limiting:**
   - "Get the most recently created user"
   - "Show me the first 10 users"
   - "Get users sorted by email"

## Response Format

The AI Agent returns responses in the same format as your existing API:

```json
{
  "data": [/* query results */],
  "message": "Query executed successfully",
  "query": "Human readable description of the executed query",
  "executionTime": "150ms"
}
```

## Security Features

- **Password Exclusion**: Automatically excludes password fields from all responses
- **Query Validation**: Validates and sanitizes all generated queries
- **Input Validation**: Validates user input (3-500 characters)
- **Error Handling**: Comprehensive error handling with descriptive messages

## Architecture

```
Frontend Query → AI Agent Controller → AI Agent Service → Google Gemini → MongoDB Query → Results
```

1. **Frontend** sends natural language query
2. **Controller** validates input and handles request
3. **AI Service** uses Google Gemini to generate MongoDB query
4. **Database** executes the optimized query
5. **Response** returns results in standard API format

## Testing

Use the provided HTTP file (`src/http/ai-agent.http`) to test the endpoints, or test via Swagger UI at `/api-docs`.

## Extending the AI Agent

To add support for additional collections:

1. Update the `getDatabaseSchema()` method in `ai-agent.service.ts`
2. Add new models to the query execution logic
3. Update the system prompt with new collection information

## Troubleshooting

1. **"Google API key is not configured"**: Ensure `GOOGLE_API_KEY` is set in your environment
2. **"Failed to generate valid MongoDB query"**: The AI couldn't understand the query - try rephrasing
3. **"Database query failed"**: Check that your MongoDB connection is working

## Performance Considerations

- The AI Agent caches schema information to reduce API calls
- Queries are optimized for performance with proper indexing hints
- Response times typically range from 1-3 seconds depending on query complexity
