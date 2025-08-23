# Postman Examples for AI Agent API

## Base URL
```
http://localhost:3000
```

## 1. Check AI Agent Status

**Method:** `GET`  
**URL:** `http://localhost:3000/api/ai-agent/status`  
**Headers:** 
```
Content-Type: application/json
```

**Expected Response:**
```json
{
  "status": "active",
  "message": "AI Agent is running and ready to process queries",
  "supportedOperations": ["find", "findOne", "count", "aggregate"],
  "availableCollections": ["users"]
}
```

---

## 2. Get Sample Queries

**Method:** `GET`  
**URL:** `http://localhost:3000/api/ai-agent/samples`  
**Headers:** 
```
Content-Type: application/json
```

**Expected Response:**
```json
{
  "queries": [
    "Get all users",
    "Find user with email john@example.com",
    "Get users created in the last 7 days",
    "Count total number of users",
    "Find users with gmail email addresses",
    "Get the most recently created user"
  ],
  "message": "Sample queries retrieved successfully"
}
```

---

## 3. Process Natural Language Queries

### Example 1: Get All Users
**Method:** `POST`  
**URL:** `http://localhost:3000/api/ai-agent/query`  
**Headers:** 
```
Content-Type: application/json
```
**Body (raw JSON):**
```json
{
  "query": "Get all users"
}
```

### Example 2: Find User by Email
**Method:** `POST`  
**URL:** `http://localhost:3000/api/ai-agent/query`  
**Headers:** 
```
Content-Type: application/json
```
**Body (raw JSON):**
```json
{
  "query": "Find user with email john@example.com"
}
```

### Example 3: Count Users
**Method:** `POST`  
**URL:** `http://localhost:3000/api/ai-agent/query`  
**Headers:** 
```
Content-Type: application/json
```
**Body (raw JSON):**
```json
{
  "query": "How many users are registered?"
}
```

### Example 4: Gmail Users
**Method:** `POST`  
**URL:** `http://localhost:3000/api/ai-agent/query`  
**Headers:** 
```
Content-Type: application/json
```
**Body (raw JSON):**
```json
{
  "query": "Find all users with Gmail email addresses"
}
```

### Example 5: Recent Users
**Method:** `POST`  
**URL:** `http://localhost:3000/api/ai-agent/query`  
**Headers:** 
```
Content-Type: application/json
```
**Body (raw JSON):**
```json
{
  "query": "Show me users created in the last 7 days"
}
```

### Example 6: Latest User
**Method:** `POST`  
**URL:** `http://localhost:3000/api/ai-agent/query`  
**Headers:** 
```
Content-Type: application/json
```
**Body (raw JSON):**
```json
{
  "query": "Get the most recently created user"
}
```

---

## Expected Response Format for Query Requests

```json
{
  "data": [
    {
      "_id": "64a1b2c3d4e5f6789012345",
      "email": "user@example.com",
      "createdAt": "2023-07-02T10:30:00.000Z",
      "updatedAt": "2023-07-02T10:30:00.000Z"
    }
  ],
  "message": "Query executed successfully",
  "query": "Find all users",
  "executionTime": "150ms"
}
```

---

## Error Responses

### 400 Bad Request (Invalid Query)
```json
{
  "message": "Query is required and must be a non-empty string"
}
```

### 500 Internal Server Error (Missing API Key)
```json
{
  "message": "Google API key is not configured"
}
```

---

## Important Notes

1. **Content-Type Header:** Always include `Content-Type: application/json` in your headers
2. **Query Length:** Queries must be between 3-500 characters
3. **API Key:** Make sure `GOOGLE_API_KEY` is set in your environment variables
4. **Database:** Ensure MongoDB is running and connected
5. **Security:** Password fields are automatically excluded from all responses

---

## Testing Steps in Postman

1. **Import Collection:** You can create a new collection in Postman called "AI Agent API"
2. **Add Environment:** Create an environment with base URL: `http://localhost:3000`
3. **Test Status First:** Start with the GET `/api/ai-agent/status` endpoint
4. **Try Sample Queries:** Use the exact JSON bodies provided above
5. **Check Response:** Verify you get the expected response format

---

## Troubleshooting

- **Connection Refused:** Make sure the server is running (`npm run dev`)
- **Validation Errors:** Check that your JSON body has the correct "query" field
- **Empty Responses:** Ensure you have some users in your database
- **API Key Errors:** Verify `GOOGLE_API_KEY` is set in your environment file
