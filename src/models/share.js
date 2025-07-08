import { DataTypes } from 'sequelize';

export default (sequelize) => {
  const Share = sequelize.define('Share', {
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
    tableName: 'shares',
    timestamps: false
  });
  return Share;
}; 