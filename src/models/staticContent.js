import { DataTypes } from 'sequelize';

export default (sequelize) => {
  const StaticContent = sequelize.define('StaticContent', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false // 'about_us' or 'privacy_policy'
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false
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
    tableName: 'static_contents',
    timestamps: false
  });
  return StaticContent;
}; 