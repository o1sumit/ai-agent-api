import { IsString, IsNotEmpty, MinLength, MaxLength, IsIn, IsOptional, IsBoolean } from 'class-validator';

export class AIQueryDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(3, { message: 'Query must be at least 3 characters long' })
  @MaxLength(500, { message: 'Query must not exceed 500 characters' })
  public query: string;

  @IsString()
  @IsNotEmpty()
  public dbUrl: string;

  @IsString()
  @IsOptional()
  @IsIn(['mongodb', 'postgres', 'mysql'])
  public dbType?: 'mongodb' | 'postgres' | 'mysql';

  @IsBoolean()
  @IsOptional()
  public refreshSchema?: boolean;
}

export class AIFeedbackDto {
  @IsString()
  @IsNotEmpty()
  public queryId: string;

  @IsString()
  @IsIn(['positive', 'negative'])
  public feedback: 'positive' | 'negative';
}

export class ProfileDbDto {
  @IsString()
  @IsNotEmpty()
  public dbUrl: string;

  @IsString()
  @IsOptional()
  @IsIn(['mongodb', 'postgres', 'mysql'])
  public dbType?: 'mongodb' | 'postgres' | 'mysql';
}