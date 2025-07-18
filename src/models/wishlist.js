import { DataTypes } from 'sequelize';

export default (sequelize) => {
  const Wishlist = sequelize.define('Wishlist', {
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
    series_id: {
      type: DataTypes.UUID,
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
    tableName: 'wishlist',
    timestamps: false,
    indexes: [
      { unique: true, fields: ['user_id', 'series_id', 'episode_id'] }
    ]
  });

  return Wishlist;
}; 