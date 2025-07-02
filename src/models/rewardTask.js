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
    day_frequency: {
      type: DataTypes.INTEGER, // How many days before user can do again
      defaultValue: 1
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