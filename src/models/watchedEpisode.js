import { DataTypes } from 'sequelize';

export default (sequelize) => {
  const WatchedEpisode = sequelize.define('WatchedEpisode', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    user_id: {
      type: DataTypes.UUID,
      references: {
        model: 'users',
        key: 'id'
      }
    },
    episode_id: {
      type: DataTypes.UUID,
      references: {
        model: 'episodes',
        key: 'id'
      }
    },
    watched_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    tableName: 'watched_episodes',
    timestamps: false
  });

  return WatchedEpisode;
}; 