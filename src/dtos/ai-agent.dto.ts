import { IsString, IsNotEmpty, MinLength, MaxLength, IsIn } from 'class-validator';

export class AIQueryDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(3, { message: 'Query must be at least 3 characters long' })
  @MaxLength(500, { message: 'Query must not exceed 500 characters' })
  public query: string;
}

export class AIFeedbackDto {
  @IsString()
  @IsNotEmpty()
  public queryId: string;

  @IsString()
  @IsIn(['positive', 'negative'])
  public feedback: 'positive' | 'negative';
}
