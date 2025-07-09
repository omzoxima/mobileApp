import { DataTypes } from 'sequelize';

export default (sequelize) => {
  const Episode = sequelize.define('Episode', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    series_id: {
      type: DataTypes.UUID,
      references: {
        model: 'series',
        key: 'id'
      }
    },
    episode_number: {
      type: DataTypes.INTEGER
    },
    video_url: {
      type: DataTypes.STRING
    },
    thumbnail_url: {
      type: DataTypes.STRING
    },
    is_published: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    reward_cost_points: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    subtitles: {
      type: DataTypes.JSONB
    },
    language: {
      type: DataTypes.STRING
    },
    description: {
      type: DataTypes.STRING
    },
    title: {
      type: DataTypes.STRING
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    },
    updated_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    tableName: 'episodes',
    timestamps: false
  });

  return Episode;
};