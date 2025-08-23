export interface SchemaField {
  name: string;
  type: string;
  required?: boolean;
  unique?: boolean;
  enum?: string[];
  ref?: string;
}

export interface CollectionSchema {
  collection: string;
  fields: SchemaField[];
  indexes: any[];
  relationships: SchemaRelationship[];
}

export interface SchemaRelationship {
  field: string;
  type: 'reference' | 'potential_reference';
  targetCollection: string;
}

export interface IndexInfo {
  name: string;
  key: { [field: string]: number };
  unique?: boolean;
  sparse?: boolean;
}

export interface DatabaseSchema {
  collections: CollectionSchema[];
  totalCollections: number;
  lastUpdated: Date;
}
