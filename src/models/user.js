import { DataTypes } from 'sequelize';

export default (sequelize) => {
  const User = sequelize.define('User', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    phone_or_email: {
      type: DataTypes.STRING,
      unique: true
    },
    login_type: {
      type: DataTypes.STRING
    },
    current_reward_balance: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    device_id: {
      type: DataTypes.STRING
    },
    device_change_count: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    is_active: {
      type: DataTypes.BOOLEAN,
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
    google_id: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: true
    },
    Name: {
      type: DataTypes.TEXT,
      defaultValue: null
    },
    role: {
      type: DataTypes.TEXT,
      defaultValue: null
    },
    password: {
      type: DataTypes.TEXT,
      defaultValue: null
    },
    facebook_id: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: true
    },
    start_date: {
      type: DataTypes.DATE,
      allowNull: true
    },
    end_date: {
      type: DataTypes.DATE,
      allowNull: true
    }
  }, {
    tableName: 'users',
    timestamps: false
  });

  return User;
}; 