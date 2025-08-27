import { connect, set } from 'mongoose';
import { NODE_ENV, DB_HOST, DB_PORT, DB_DATABASE } from '@config';

export const dbConnection = async () => {
  const dbConfig = {
    url: `mongodb://${DB_HOST}:${DB_PORT}/${DB_DATABASE}`,
    // url: `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB_HOST}/${process.env.DB_DATABASE}?retryWrites=true&w=majority`,
  };

  if (NODE_ENV !== 'production') {
    set('debug', true);
  }

  await connect(dbConfig.url);
};
