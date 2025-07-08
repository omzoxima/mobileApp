import { Sequelize } from 'sequelize';
import config from '../config/index.js';
import Category from './category.js';
import Series from './series.js';
import Episode from './episode.js';
import User from './user.js';
import RewardTask from './rewardTask.js';
import RewardTransaction from './rewardTransaction.js';
import WatchedEpisode from './watchedEpisode.js';
import Wishlist from './wishlist.js';
import PointPurchase from './pointPurchase.js';
import EpisodeBundlePrice from './episodeBundlePrice.js';
import StaticContent from './staticContent.js';
import EpisodeUserAccess from './episodeUserAccess.js';
import Like from './like.js';
import Share from './share.js';

const sequelize = new Sequelize(
  config.DB_NAME,
  config.DB_USER,
  config.DB_PASSWORD,
  {
    host: config.DB_HOST,
    port: config.DB_PORT,
    dialect: 'postgres', // Explicitly set the dialect here
    dialectOptions: config.DB_DIALECT_OPTIONS || {}, // Ensure this is an object
    pool: {
      max: 5,
      min: 0,
      acquire: 30000,
      idle: 10000
    },
    logging: false,
  }
);

const models = {
  Category: Category(sequelize),
  Series: Series(sequelize),
  Episode: Episode(sequelize),
  Like: Like(sequelize),
  Share: Share(sequelize),
  User: User(sequelize),
  RewardTask: RewardTask(sequelize),
  RewardTransaction: RewardTransaction(sequelize),
  WatchedEpisode: WatchedEpisode(sequelize),
  Wishlist: Wishlist(sequelize),
  PointPurchase: PointPurchase(sequelize),
  EpisodeBundlePrice: EpisodeBundlePrice(sequelize),
  StaticContent: StaticContent(sequelize),
  EpisodeUserAccess: EpisodeUserAccess(sequelize)
};

models.Category.hasMany(models.Series, { foreignKey: 'category_id' });
models.Series.belongsTo(models.Category, { foreignKey: 'category_id' });
models.Series.hasMany(models.Episode, { foreignKey: 'series_id' });
models.Episode.belongsTo(models.Series, { foreignKey: 'series_id' });
//models.EpisodeBundlePrice.belongsTo(models.Series, { foreignKey: 'series_id' });

export { sequelize };
export default models;