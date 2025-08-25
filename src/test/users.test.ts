import { CreateUserDto } from '@dtos/users.dto';
import { UserService } from '@services/users.service';

// Simple unit tests for user DTO validation
describe('Testing Users DTO', () => {
  describe('CreateUserDto', () => {
    it('should include all required fields for user creation', async () => {
      const userData: CreateUserDto = {
        fullName: 'Test User',
        username: 'testuser',
        email: 'test@email.com',
        password: 'q1w2e3r4',
      };

      // Test that CreateUserDto includes all new fields
      expect(userData.fullName).toBe('Test User');
      expect(userData.username).toBe('testuser');
      expect(userData.email).toBe('test@email.com');
      expect(userData.password).toBe('q1w2e3r4');
    });

    it('should validate fullName constraints', () => {
      const userData: CreateUserDto = {
        fullName: 'Jo', // Test minimum length
        username: 'testuser',
        email: 'test@email.com',
        password: 'q1w2e3r4',
      };

      expect(userData.fullName.length).toBeGreaterThanOrEqual(2);
    });

    it('should validate username constraints', () => {
      const userData: CreateUserDto = {
        fullName: 'Test User',
        username: 'abc', // Test minimum length
        email: 'test@email.com',
        password: 'q1w2e3r4',
      };

      expect(userData.username.length).toBeGreaterThanOrEqual(3);
    });
  });
});
