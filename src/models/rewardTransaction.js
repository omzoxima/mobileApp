import { DataTypes } from 'sequelize';

export default (sequelize) => {
  const RewardTransaction = sequelize.define('RewardTransaction', {
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
    episode_bundle_id: {
      type: DataTypes.UUID,
      references: {
        model: 'episode_bundle_prices',
        key: 'id'
      }
    },
    type: {
      type: DataTypes.STRING // 'earn' or 'spend'
    },
    points: {
      type: DataTypes.INTEGER
    },
    streak_count: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    disabled_streak_count: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    task_id: {
      type: DataTypes.UUID,
      references: {
        model: 'reward_tasks',
        key: 'id'
      }
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    tableName: 'reward_transactions',
    timestamps: false
  });

  return RewardTransaction;
}; 