# Enhanced AI Agent with Dynamic Schema & User Memory

## 🚀 Overview

The Enhanced AI Agent now features:
- **Dynamic Schema Detection**: Automatically discovers and analyzes your database structure
- **User-Specific Memory**: Learns from each user's query patterns and preferences
- **Authentication Integration**: Secure, user-based query processing
- **Personalized Suggestions**: AI improves accuracy based on user history
- **Advanced Logging**: Comprehensive query tracking and performance monitoring

## 🔧 Key Features

### 1. Dynamic Schema Detection
- Automatically scans all MongoDB collections
- Infers field types from sample documents
- Detects relationships and indexes
- Caches schema information for performance
- Updates schema dynamically as your database evolves

### 2. User Memory System
- **Query History**: Tracks all user queries and their success rates
- **Learning Patterns**: Identifies common query patterns per user
- **Skill Assessment**: Automatically determines user skill level (beginner/intermediate/advanced)
- **Personalized Suggestions**: Provides relevant suggestions based on user history
- **Feedback Loop**: Learns from positive/negative feedback

### 3. Authentication & Security
- All query endpoints require JWT authentication
- User-specific data isolation
- Secure query logging with user context
- Password fields automatically excluded from all responses

## 📡 API Endpoints

### Public Endpoints (No Authentication Required)

#### Get Status
```http
GET /api/ai-agent/status
```
Returns enhanced agent status with feature list.

#### Get Sample Queries
```http
GET /api/ai-agent/samples
```
Returns example queries to help users get started.

### Authenticated Endpoints (Require JWT Token)

#### Process Natural Language Query
```http
POST /api/ai-agent/query
Authorization: Bearer YOUR_JWT_TOKEN
Content-Type: application/json

{
  "query": "Get all users with Gmail addresses created in the last week"
}
```

**Enhanced Response:**
```json
{
  "data": [/* query results */],
  "message": "Query executed successfully",
  "query": "Find users with Gmail addresses from last week",
  "suggestions": [
    "Based on your previous queries, you might want to add sorting",
    "You often query: users, posts",
    "Similar patterns you've used: get_all_email, find_date"
  ],
  "executionTime": 1250,
  "memoryInsights": {
    "similarQueries": 3,
    "userLevel": "intermediate", 
    "queryPattern": "find_email_date"
  }
}
```

#### Record Feedback
```http
POST /api/ai-agent/feedback
Authorization: Bearer YOUR_JWT_TOKEN
Content-Type: application/json

{
  "queryId": "64a1b2c3d4e5f6789012345",
  "feedback": "positive"
}
```

#### Get User Statistics
```http
GET /api/ai-agent/stats
Authorization: Bearer YOUR_JWT_TOKEN
```

**Response:**
```json
{
  "data": {
    "totalQueries": 45,
    "successfulQueries": 42,
    "successRate": "93.33%",
    "averageExecutionTime": 1150,
    "skillLevel": "intermediate",
    "frequentCollections": ["users", "posts", "comments"]
  },
  "message": "User statistics retrieved successfully"
}
```

#### Refresh Schema Cache
```http
POST /api/ai-agent/refresh-schema
Authorization: Bearer YOUR_JWT_TOKEN
```

## 🧠 How Memory Learning Works

### 1. Query Pattern Recognition
The AI identifies patterns in your queries:
- `get_all` - "Get all users", "Show all posts"
- `find_email` - "Find user with email...", "Search by email..."
- `count` - "How many users", "Count total posts"
- `find_date` - "Users created today", "Posts from last week"

### 2. User Skill Assessment
- **Beginner**: Simple queries, basic suggestions
- **Intermediate**: More complex operations, optimization tips
- **Advanced**: Aggregation pipelines, performance insights

### 3. Personalized Optimization
- Suggests frequently used collections
- Recommends similar successful query patterns
- Provides context-aware tips based on query history
- Learns from feedback to improve future suggestions

## 🔍 Dynamic Schema Detection

### Automatic Discovery
```javascript
// The system automatically detects:
{
  "collection": "users",
  "fields": [
    {"name": "email", "type": "String", "required": true, "unique": true},
    {"name": "password", "type": "String", "required": true},
    {"name": "profile", "type": "Object"},
    {"name": "posts", "type": "Array<ObjectId>", "ref": "Post"}
  ],
  "indexes": [
    {"name": "email_1", "key": {"email": 1}},
    {"name": "createdAt_-1", "key": {"createdAt": -1}}
  ],
  "relationships": [
    {"field": "posts", "type": "reference", "targetCollection": "posts"}
  ]
}
```

### Schema-Aware Query Generation
The AI uses real schema information to:
- Generate accurate field references
- Suggest proper data types
- Recommend indexed fields for better performance
- Detect and use relationships between collections

## 🔐 Authentication Setup

### 1. User Registration/Login
First, users must authenticate:
```http
POST /auth/login
Content-Type: application/json

{
  "email": "user@example.com", 
  "password": "password123"
}
```

### 2. Use JWT Token
Include the returned JWT token in all AI agent requests:
```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## 📊 Memory Data Models

### Query History
```javascript
{
  "userId": "64a1b2c3d4e5f6789012345",
  "query": "Get all users with Gmail addresses",
  "generatedMongoQuery": "UserModel.find({email: {$regex: '@gmail.com'}}, {password: 0})",
  "queryType": "find",
  "executionTime": 1200,
  "resultCount": 15,
  "wasSuccessful": true,
  "contextTags": ["email-search", "user-related"],
  "queryPattern": "find_email"
}
```

### User Preferences
```javascript
{
  "userId": "64a1b2c3d4e5f6789012345",
  "frequentCollections": ["users", "posts"],
  "queryHistory": [
    {"pattern": "get_all", "frequency": 12, "lastUsed": "2023-07-02T10:30:00Z"},
    {"pattern": "find_email", "frequency": 8, "lastUsed": "2023-07-02T09:15:00Z"}
  ],
  "learningProfile": {
    "skillLevel": "intermediate",
    "preferredResponseDetail": "detailed",
    "commonMistakes": ["missing_sort", "no_limit"]
  }
}
```

## 🚀 Getting Started

### 1. Environment Setup
```env
# Add to your .env file
GOOGLE_API_KEY=your-google-gemini-api-key-here
```

### 2. Database Setup
The system automatically creates the required collections:
- `aimemories` - Query history and performance data
- `userpreferences` - User learning profiles and preferences

### 3. Test the Enhanced Agent
1. Start your server: `npm run dev`
2. Login to get JWT token: `POST /auth/login`
3. Try a query: `POST /api/ai-agent/query` with Authorization header
4. Check your stats: `GET /api/ai-agent/stats`

## 🎯 Example Learning Scenario

### First Query (Beginner Level)
**User Query**: "Get all users"
**AI Response**: Basic find operation + beginner tips
**Memory**: Records simple pattern, marks user as beginner

### After 10 Successful Queries (Intermediate Level)
**User Query**: "Get Gmail users from last week"
**AI Response**: Complex date + regex query + optimization suggestions
**Memory**: Recognizes pattern, suggests similar queries, upgrades skill level

### After 50+ Queries (Advanced Level)
**User Query**: "Analyze user signup trends by month"
**AI Response**: Aggregation pipeline + performance insights
**Memory**: Provides advanced suggestions, remembers preferred analysis patterns

## 🔧 Performance Optimizations

- **Schema Caching**: 5-minute TTL to balance accuracy and performance
- **Memory Indexing**: Optimized database indexes for fast query retrieval
- **Pattern Recognition**: Efficient pattern matching for suggestion generation
- **Batch Operations**: Bulk memory updates for better performance

## 🐛 Troubleshooting

### Common Issues

1. **"Authentication required"**: Include JWT token in Authorization header
2. **"Schema detection failed"**: Ensure MongoDB connection is stable
3. **"No memory insights"**: User needs to make a few queries first
4. **"Pattern not recognized"**: Try rephrasing query or check suggestions

### Debug Information
Check logs for detailed information about:
- Schema detection process
- Query pattern extraction
- Memory update operations
- AI response generation

This enhanced AI agent provides a truly personalized and intelligent database querying experience that learns and improves with each interaction!
