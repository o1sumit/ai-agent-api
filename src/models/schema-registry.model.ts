import { model, Schema, Document } from 'mongoose';
import { DBType } from '@interfaces/ai-agent.interface';

export interface SchemaRegistryDoc extends Document {
  dbKey: string;
  dbType: DBType;
  normalizedUrl: string;
  schemaJson: string;
  totalCollections?: number;
  totalTables?: number;
  lastUpdated: Date;
  ttlMs: number;
}

const SchemaRegistrySchema: Schema = new Schema(
  {
    dbKey: { type: String, required: true, unique: true, index: true },
    dbType: { type: String, enum: ['mongodb', 'postgres', 'mysql'], required: true },
    normalizedUrl: { type: String, required: true },
    schemaJson: { type: String, required: true },
    totalCollections: Number,
    totalTables: Number,
    lastUpdated: { type: Date, default: Date.now },
    ttlMs: { type: Number, default: 24 * 60 * 60 * 1000 },
  },
  { timestamps: true },
);

export const SchemaRegistryModel = model<SchemaRegistryDoc>('SchemaRegistry', SchemaRegistrySchema);
