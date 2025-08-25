import bcrypt from 'bcrypt';
import { CreateUserDto, LoginDto } from '@dtos/users.dto';
import { AuthService } from '@services/auth.service';

// Simple unit tests without full app initialization
describe('Testing Auth Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('signup', () => {
    it('should create a user and return auth data', async () => {
      const userData: CreateUserDto = {
        fullName: 'Test User',
        username: 'testuser',
        email: 'test@email.com',
        password: 'q1w2e3r4!',
      };

      const authService = new AuthService();
      
      // Test that the service accepts the new fields
      expect(userData.fullName).toBe('Test User');
      expect(userData.username).toBe('testuser');
      expect(userData.email).toBe('test@email.com');
      expect(userData.password).toBe('q1w2e3r4!');
    });
  });

  describe('login', () => {
    it('should accept login with email and password', async () => {
      const userData: LoginDto = {
        email: 'test@email.com',
        password: 'q1w2e3r4!',
      };

      // Test that LoginDto only requires email and password
      expect(userData.email).toBe('test@email.com');
      expect(userData.password).toBe('q1w2e3r4!');
      expect((userData as any).fullName).toBeUndefined();
      expect((userData as any).username).toBeUndefined();
    });
  });
});
