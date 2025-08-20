import { DataTypes } from 'sequelize';

export default (sequelize) => {
  const EpisodeUserAccess = sequelize.define('EpisodeUserAccess', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    episode_id: {
      type: DataTypes.UUID,
      allowNull: false
    },
    series_id: {
      type: DataTypes.UUID,
      allowNull: false
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false
    },
    is_locked: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    },
    updated_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    },
    point: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    }
  }, {
    tableName: 'episode_user_access',
    timestamps: false
  });

  return EpisodeUserAccess;
}; 