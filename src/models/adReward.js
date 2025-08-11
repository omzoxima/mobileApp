import { DataTypes } from 'sequelize';

export default (sequelize) => {
  const AdReward = sequelize.define('AdReward', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id'
      }
    },
    points: {
      type: DataTypes.DECIMAL(10, 2), // Allows up to 10 digits with 2 decimal places
      allowNull: false,
      defaultValue: 0.00
    },
    series_id: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'series',
        key: 'id'
      }
    },
    episode_id: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'episodes',
        key: 'id'
      }
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    tableName: 'ad_rewards',
    timestamps: false,
    indexes: [
      { fields: ['user_id'] },
      { fields: ['user_id', 'created_at'] }
    ]
  });

  return AdReward;
};
