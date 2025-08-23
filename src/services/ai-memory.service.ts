import { Service } from 'typedi';
import { AIMemoryModel, UserPreferencesModel, AIMemory, UserPreferences } from '@models/ai-memory.model';
import { MemoryInsight, UserStats } from '@interfaces/ai-memory.interface';
import { logger } from '@utils/logger';

@Service()
export class AIMemoryService {
  public async recordQuery(
    userId: string,
    query: string,
    generatedMongoQuery: string,
    queryType: 'find' | 'findOne' | 'count' | 'aggregate',
    collections: string[],
    executionTime: number,
    resultCount: number,
    wasSuccessful: boolean,
  ): Promise<void> {
    try {
      const queryPattern = this.extractQueryPattern(query);
      const contextTags = this.extractContextTags(query);

      // Record the query
      await AIMemoryModel.create({
        userId,
        query,
        generatedMongoQuery,
        queryType,
        collections,
        executionTime,
        resultCount,
        wasSuccessful,
        contextTags,
        queryPattern,
      });

      // Update user preferences
      await this.updateUserPreferences(userId, queryPattern, collections, wasSuccessful);

      logger.info(`Recorded AI query for user ${userId}: ${queryPattern}`);
    } catch (error) {
      logger.error(`Error recording query: ${error.message}`);
    }
  }

  public async getMemoryInsights(userId: string, currentQuery: string): Promise<MemoryInsight> {
    try {
      const queryPattern = this.extractQueryPattern(currentQuery);

      // Get similar queries from user's history
      const similarQueries = await this.getSimilarQueries(userId, queryPattern, currentQuery);

      // Get user preferences
      const userPreferences = await UserPreferencesModel.findOne({ userId });

      // Generate suggestions based on memory
      const suggestions = await this.generateSuggestions(userId, currentQuery, similarQueries, userPreferences);

      return {
        similarQueries,
        userPreferences,
        suggestions,
        queryPattern,
      };
    } catch (error) {
      logger.error(`Error getting memory insights: ${error.message}`);
      return {
        similarQueries: [],
        userPreferences: null,
        suggestions: [],
        queryPattern: this.extractQueryPattern(currentQuery),
      };
    }
  }

  private async getSimilarQueries(userId: string, queryPattern: string, currentQuery: string): Promise<AIMemory[]> {
    try {
      // First, try exact pattern match
      let similarQueries = await AIMemoryModel.find({
        userId,
        queryPattern,
        wasSuccessful: true,
      })
        .sort({ timestamp: -1 })
        .limit(3)
        .lean();

      // If no exact matches, try fuzzy matching
      if (similarQueries.length === 0) {
        const keywords = this.extractKeywords(currentQuery);
        const regexPattern = new RegExp(keywords.join('|'), 'i');

        similarQueries = await AIMemoryModel.find({
          userId,
          $or: [{ query: regexPattern }, { queryPattern: regexPattern }],
          wasSuccessful: true,
        })
          .sort({ timestamp: -1 })
          .limit(3)
          .lean();
      }

      return similarQueries;
    } catch (error) {
      logger.error(`Error getting similar queries: ${error.message}`);
      return [];
    }
  }

  private async updateUserPreferences(userId: string, queryPattern: string, collections: string[], wasSuccessful: boolean): Promise<void> {
    try {
      let preferences = await UserPreferencesModel.findOne({ userId });

      if (!preferences) {
        preferences = new UserPreferencesModel({
          userId,
          frequentCollections: collections,
          queryHistory: [{ pattern: queryPattern, frequency: 1, lastUsed: new Date() }],
          learningProfile: {
            skillLevel: 'beginner',
            preferredResponseDetail: 'detailed',
            commonMistakes: [],
          },
        });
      } else {
        // Update frequent collections
        collections.forEach(collection => {
          if (!preferences?.frequentCollections?.includes(collection)) {
            if (!preferences?.frequentCollections) {
              preferences.frequentCollections = [];
            }
            preferences.frequentCollections.push(collection);
          }
        });

        // Update query history
        const existingPattern = preferences.queryHistory?.find(h => h.pattern === queryPattern);
        if (existingPattern) {
          existingPattern.frequency += 1;
          existingPattern.lastUsed = new Date();
        } else {
          if (!preferences.queryHistory) {
            preferences.queryHistory = [];
          }
          preferences.queryHistory.push({
            pattern: queryPattern,
            frequency: 1,
            lastUsed: new Date(),
          });
        }

        // Update skill level based on query complexity and success rate
        if (wasSuccessful) {
          const successfulQueries = await AIMemoryModel.countDocuments({
            userId,
            wasSuccessful: true,
          });

          if (successfulQueries > 50 && preferences.learningProfile?.skillLevel === 'beginner') {
            if (preferences.learningProfile) {
              preferences.learningProfile.skillLevel = 'intermediate';
            }
          } else if (successfulQueries > 150 && preferences.learningProfile?.skillLevel === 'intermediate') {
            if (preferences.learningProfile) {
              preferences.learningProfile.skillLevel = 'advanced';
            }
          }
        }

        // Record common mistakes
        if (!wasSuccessful && preferences.learningProfile?.commonMistakes) {
          if (!preferences.learningProfile.commonMistakes.includes(queryPattern)) {
            preferences.learningProfile.commonMistakes.push(queryPattern);
          }
        }
      }

      await preferences.save();
    } catch (error) {
      logger.error(`Error updating user preferences: ${error.message}`);
    }
  }

  private async generateSuggestions(
    userId: string,
    currentQuery: string,
    similarQueries: AIMemory[],
    userPreferences: UserPreferences | null,
  ): Promise<string[]> {
    const suggestions: string[] = [];

    // Suggestions based on similar successful queries
    if (similarQueries.length > 0) {
      suggestions.push('Based on your previous queries, you might want to add sorting or limiting results.');

      const commonCollections = this.findCommonCollections(similarQueries);
      if (commonCollections.length > 0) {
        suggestions.push(`Consider also querying: ${commonCollections.join(', ')}`);
      }
    }

    // Suggestions based on user preferences
    if (userPreferences?.frequentCollections && userPreferences.frequentCollections.length > 0) {
      const currentCollections = this.extractCollectionsFromQuery(currentQuery);
      const suggestedCollections = userPreferences.frequentCollections.filter(col => !currentCollections.includes(col));

      if (suggestedCollections.length > 0) {
        suggestions.push(`You often query: ${suggestedCollections.slice(0, 3).join(', ')}`);
      }
    }

    // Suggestions based on common patterns
    if (userPreferences?.queryHistory && userPreferences.queryHistory.length > 0) {
      const frequentPatterns = userPreferences.queryHistory
        .sort((a, b) => b.frequency - a.frequency)
        .slice(0, 3)
        .map(h => h.pattern);

      const currentPattern = this.extractQueryPattern(currentQuery);
      const relatedPatterns = frequentPatterns.filter(p => p !== currentPattern);

      if (relatedPatterns.length > 0) {
        suggestions.push(`Similar patterns you've used: ${relatedPatterns.join(', ')}`);
      }
    }

    // Skill-based suggestions
    if (userPreferences?.learningProfile?.skillLevel === 'beginner') {
      suggestions.push('Tip: Try using specific field names for more precise results.');
    } else if (userPreferences?.learningProfile?.skillLevel === 'advanced') {
      suggestions.push('Consider using aggregation pipelines for complex data analysis.');
    }

    return suggestions;
  }

  private extractQueryPattern(query: string): string {
    const lowerQuery = query.toLowerCase();

    // Extract main action
    let pattern = '';
    if (lowerQuery.includes('get all') || lowerQuery.includes('find all') || lowerQuery.includes('show all')) {
      pattern += 'get_all';
    } else if (lowerQuery.includes('count') || lowerQuery.includes('how many')) {
      pattern += 'count';
    } else if (lowerQuery.includes('find') || lowerQuery.includes('get') || lowerQuery.includes('search')) {
      pattern += 'find';
    } else if (lowerQuery.includes('latest') || lowerQuery.includes('recent') || lowerQuery.includes('newest')) {
      pattern += 'latest';
    } else {
      pattern += 'general';
    }

    // Add filters
    if (lowerQuery.includes('email') || lowerQuery.includes('@')) {
      pattern += '_email';
    }
    if (lowerQuery.includes('date') || lowerQuery.includes('created') || lowerQuery.includes('last')) {
      pattern += '_date';
    }
    if (lowerQuery.includes('name') || lowerQuery.includes('title')) {
      pattern += '_name';
    }

    return pattern;
  }

  private extractContextTags(query: string): string[] {
    const tags: string[] = [];
    const lowerQuery = query.toLowerCase();

    if (lowerQuery.includes('email') || lowerQuery.includes('@')) tags.push('email-search');
    if (lowerQuery.includes('date') || lowerQuery.includes('created') || lowerQuery.includes('last')) tags.push('date-filter');
    if (lowerQuery.includes('count') || lowerQuery.includes('how many')) tags.push('count-operation');
    if (lowerQuery.includes('sort') || lowerQuery.includes('order')) tags.push('sorting');
    if (lowerQuery.includes('limit') || lowerQuery.includes('first') || lowerQuery.includes('top')) tags.push('limiting');
    if (lowerQuery.includes('user')) tags.push('user-related');
    if (lowerQuery.includes('recent') || lowerQuery.includes('latest')) tags.push('recent-data');

    return tags;
  }

  private extractKeywords(query: string): string[] {
    const stopWords = ['get', 'find', 'show', 'all', 'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by'];
    return query
      .toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.includes(word));
  }

  private findCommonCollections(queries: AIMemory[]): string[] {
    const collectionCounts: { [key: string]: number } = {};

    queries.forEach(query => {
      query.collections.forEach(collection => {
        collectionCounts[collection] = (collectionCounts[collection] || 0) + 1;
      });
    });

    return Object.entries(collectionCounts)
      .filter(([, count]) => count > 1)
      .map(([collection]) => collection);
  }

  private extractCollectionsFromQuery(query: string): string[] {
    const lowerQuery = query.toLowerCase();
    const collections: string[] = [];

    if (lowerQuery.includes('user')) collections.push('users');
    if (lowerQuery.includes('post')) collections.push('posts');
    if (lowerQuery.includes('comment')) collections.push('comments');
    if (lowerQuery.includes('order')) collections.push('orders');
    if (lowerQuery.includes('product')) collections.push('products');

    return collections;
  }

  public async recordFeedback(userId: string, queryId: string, feedback: 'positive' | 'negative'): Promise<void> {
    try {
      await AIMemoryModel.findOneAndUpdate({ _id: queryId, userId }, { feedback });
      logger.info(`Recorded feedback for query ${queryId}: ${feedback}`);
    } catch (error) {
      logger.error(`Error recording feedback: ${error.message}`);
    }
  }

  public async getUserStats(userId: string): Promise<UserStats | null> {
    try {
      const totalQueries = await AIMemoryModel.countDocuments({ userId });
      const successfulQueries = await AIMemoryModel.countDocuments({ userId, wasSuccessful: true });
      const averageExecutionTime = await AIMemoryModel.aggregate([
        { $match: { userId, wasSuccessful: true } },
        { $group: { _id: null, avgTime: { $avg: '$executionTime' } } },
      ]);

      const preferences = await UserPreferencesModel.findOne({ userId });

      return {
        totalQueries,
        successfulQueries,
        successRate: totalQueries > 0 ? ((successfulQueries / totalQueries) * 100).toFixed(2) + '%' : '0%',
        averageExecutionTime: averageExecutionTime[0]?.avgTime || 0,
        skillLevel: preferences?.learningProfile?.skillLevel || 'beginner',
        frequentCollections: preferences?.frequentCollections || [],
      };
    } catch (error) {
      logger.error(`Error getting user stats: ${error.message}`);
      return null;
    }
  }
}
