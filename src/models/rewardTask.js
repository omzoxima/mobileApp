import { DataTypes } from 'sequelize';

export default (sequelize) => {
  const RewardTask = sequelize.define('RewardTask', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    description: {
      type: DataTypes.STRING
    },
    points: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    type: {
      type: DataTypes.STRING // e.g., 'login', 'deeplink'
    },
    trigger: {
      type: DataTypes.STRING, // What triggers the reward (e.g., 'daily_streak_3', 'instagram_follow')
      allowNull: true
    },
    repeat_type: {
      type: DataTypes.STRING, // 'one_time', 'daily', 'share_meter', etc.
      allowNull: true
    },
    unlock_value: {
      type: DataTypes.INTEGER, // Number of episodes to unlock
      allowNull: true
    },
    max_count: {
      type: DataTypes.INTEGER, // Max times this reward can be earned (null for unlimited)
      allowNull: true
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
    tableName: 'reward_tasks',
    timestamps: false
  });

  return RewardTask;
}; 