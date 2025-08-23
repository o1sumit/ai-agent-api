import { Service } from 'typedi';
import mongoose from 'mongoose';
import { SchemaField, CollectionSchema, SchemaRelationship } from '@interfaces/schema-detector.interface';
import { logger } from '@utils/logger';

@Service()
export class SchemaDetectorService {
  private schemaCache: Map<string, CollectionSchema> = new Map();
  private cacheExpiry: Map<string, number> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  public async getAllSchemas(conn?: mongoose.Connection): Promise<CollectionSchema[]> {
    try {
      const db = (conn || mongoose.connection).db;
      const collections = await db.listCollections().toArray();
      const schemas: CollectionSchema[] = [];

      for (const collection of collections) {
        const schema = await this.getCollectionSchema(collection.name, conn);
        if (schema) {
          schemas.push(schema);
        }
      }

      return schemas;
    } catch (error: any) {
      logger.error(`Error getting all schemas: ${error.message}`);
      throw error;
    }
  }

  public async getCollectionSchema(collectionName: string, conn?: mongoose.Connection): Promise<CollectionSchema | null> {
    try {
      // Check cache first
      const cacheKey = `${conn ? 'external' : 'default'}_${collectionName}`;
      const cached = this.getCachedSchema(cacheKey);
      if (cached) {
        return cached;
      }

      const db = (conn || mongoose.connection).db;
      const collection = db.collection(collectionName);

      // Get sample documents to infer schema
      const samples = await collection.find({}).limit(10).toArray();
      if (samples.length === 0) {
        logger.warn(`No documents found in collection: ${collectionName}`);
        return null;
      }

      // Get indexes
      const indexes = await collection.indexes();

      // Infer schema from samples
      const fields = this.inferSchemaFromSamples(samples);

      // Get Mongoose model info if available
      const mongooseSchema = this.getMongooseSchemaInfo(collectionName, conn);
      if (mongooseSchema) {
        this.mergeMongooseSchemaInfo(fields, mongooseSchema);
      }

      const schema: CollectionSchema = {
        collection: collectionName,
        fields,
        indexes,
        relationships: this.detectRelationships(fields),
      };

      // Cache the result
      this.cacheSchema(cacheKey, schema);

      return schema;
    } catch (error) {
      logger.error(`Error getting schema for ${collectionName}: ${error.message}`);
      return null;
    }
  }

  private getCachedSchema(cacheKey: string): CollectionSchema | null {
    const cached = this.schemaCache.get(cacheKey);
    const expiry = this.cacheExpiry.get(cacheKey);

    if (cached && expiry && Date.now() < expiry) {
      return cached;
    }

    // Remove expired cache
    if (cached) {
      this.schemaCache.delete(cacheKey);
      this.cacheExpiry.delete(cacheKey);
    }

    return null;
  }

  private cacheSchema(cacheKey: string, schema: CollectionSchema): void {
    this.schemaCache.set(cacheKey, schema);
    this.cacheExpiry.set(cacheKey, Date.now() + this.CACHE_TTL);
  }

  private inferSchemaFromSamples(samples: any[]): SchemaField[] {
    const fieldTypes: Map<string, Set<string>> = new Map();
    const fieldFrequency: Map<string, number> = new Map();

    // Analyze all samples
    samples.forEach(doc => {
      this.analyzeDocument(doc, fieldTypes, fieldFrequency, '');
    });

    // Convert to schema fields
    const fields: SchemaField[] = [];
    fieldTypes.forEach((types, fieldName) => {
      const frequency = fieldFrequency.get(fieldName) || 0;
      const isRequired = frequency === samples.length;

      // Determine primary type
      let primaryType = 'Mixed';
      if (types.size === 1) {
        primaryType = Array.from(types)[0];
      } else if (types.has('ObjectId')) {
        primaryType = 'ObjectId';
      } else if (types.has('String')) {
        primaryType = 'String';
      } else if (types.has('Number')) {
        primaryType = 'Number';
      }

      fields.push({
        name: fieldName,
        type: primaryType,
        required: isRequired,
      });
    });

    return fields;
  }

  private analyzeDocument(doc: any, fieldTypes: Map<string, Set<string>>, fieldFrequency: Map<string, number>, prefix: string): void {
    Object.keys(doc).forEach(key => {
      const fieldName = prefix ? `${prefix}.${key}` : key;
      const value = doc[key];
      const type = this.getFieldType(value);

      if (!fieldTypes.has(fieldName)) {
        fieldTypes.set(fieldName, new Set());
        fieldFrequency.set(fieldName, 0);
      }

      const fieldTypeSet = fieldTypes.get(fieldName);
      if (fieldTypeSet) {
        fieldTypeSet.add(type);
      }
      const currentFreq = fieldFrequency.get(fieldName) || 0;
      fieldFrequency.set(fieldName, currentFreq + 1);

      // Recursively analyze nested objects (but not arrays of objects to avoid complexity)
      if (type === 'Object' && value && typeof value === 'object' && !Array.isArray(value)) {
        this.analyzeDocument(value, fieldTypes, fieldFrequency, fieldName);
      }
    });
  }

  private getFieldType(value: any): string {
    if (value === null || value === undefined) {
      return 'Mixed';
    }

    if (mongoose.Types.ObjectId.isValid(value) && typeof value === 'object') {
      return 'ObjectId';
    }

    if (value instanceof Date) {
      return 'Date';
    }

    if (Array.isArray(value)) {
      if (value.length > 0) {
        const elementType = this.getFieldType(value[0]);
        return `Array<${elementType}>`;
      }
      return 'Array';
    }

    if (typeof value === 'object') {
      return 'Object';
    }

    if (typeof value === 'string') {
      // Check if it looks like an ObjectId string
      if (/^[0-9a-fA-F]{24}$/.test(value)) {
        return 'ObjectId';
      }
      return 'String';
    }

    if (typeof value === 'number') {
      return Number.isInteger(value) ? 'Number' : 'Number';
    }

    if (typeof value === 'boolean') {
      return 'Boolean';
    }

    return 'Mixed';
  }

  private getMongooseSchemaInfo(collectionName: string, conn?: mongoose.Connection): any {
    try {
      // Try to find the Mongoose model
      const models = conn ? conn.models : mongoose.models;
      const modelName = Object.keys(models).find(name => models[name].collection.name === collectionName);

      if (modelName) {
        const model = models[modelName];
        return model.schema;
      }
    } catch (error: any) {
      logger.warn(`Could not get Mongoose schema info for ${collectionName}: ${error.message}`);
    }
    return null;
  }

  private mergeMongooseSchemaInfo(fields: SchemaField[], mongooseSchema: any): void {
    try {
      const schemaPaths = mongooseSchema.paths;

      fields.forEach(field => {
        const schemaPath = schemaPaths[field.name];
        if (schemaPath) {
          // Update field info with Mongoose schema details
          if (schemaPath.isRequired) {
            field.required = true;
          }
          if (schemaPath.options?.unique) {
            field.unique = true;
          }
          if (schemaPath.options?.enum) {
            field.enum = schemaPath.options.enum;
          }
          if (schemaPath.options?.ref) {
            field.ref = schemaPath.options.ref;
          }
        }
      });
    } catch (error) {
      logger.warn(`Error merging Mongoose schema info: ${error.message}`);
    }
  }

  private detectRelationships(fields: SchemaField[]): SchemaRelationship[] {
    const relationships: SchemaRelationship[] = [];

    fields.forEach(field => {
      if (field.ref) {
        relationships.push({
          field: field.name,
          type: 'reference',
          targetCollection: field.ref.toLowerCase() + 's', // Simple pluralization
        });
      }

      // Detect potential foreign keys by naming convention
      if (field.name.endsWith('Id') && field.type === 'ObjectId') {
        const potentialRef = field.name.replace('Id', '');
        relationships.push({
          field: field.name,
          type: 'potential_reference',
          targetCollection: potentialRef.toLowerCase() + 's',
        });
      }
    });

    return relationships;
  }

  public async refreshCache(): Promise<void> {
    this.schemaCache.clear();
    this.cacheExpiry.clear();
    logger.info('Schema cache cleared');
  }

  public getSchemaAsString(schemas: CollectionSchema[]): string {
    return JSON.stringify(
      schemas.map(schema => ({
        collection: schema.collection,
        fields: schema.fields.map(field => ({
          name: field.name,
          type: field.type,
          required: field.required || false,
          unique: field.unique || false,
          enum: field.enum,
          ref: field.ref,
        })),
        indexes: schema.indexes.map(index => ({
          name: index.name,
          key: index.key,
        })),
        relationships: schema.relationships,
      })),
      null,
      2,
    );
  }
}
