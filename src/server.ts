import { App } from '@/app';
import { AuthRoute } from '@routes/auth.route';
import { UserRoute } from '@routes/users.route';
import { AIAgentRoute } from '@routes/ai-agent.route';
import { ChatRoute } from '@routes/chat.route';
import { ValidateEnv } from '@utils/validateEnv';

ValidateEnv();

const app = new App([new UserRoute(), new AuthRoute(), new AIAgentRoute(), new ChatRoute()]);

app.listen();
